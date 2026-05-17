# Plan 1E-title — Auto-generated chat thread titles

**Date:** 2026-05-16
**Status:** Spec
**Sub-plan of:** 1E (chat assistant)

---

## 1. Goal

Generate a concise (`≤5 words`, ~30 chars) title for each new chat thread on
the user's first message, fire-and-forget. The chat response is not delayed.
If the LLM call fails or the user has manually set a title, no update lands.

This closes the 1E-threads follow-up: "LLM-generated thread titles
(auto-summary)."

---

## 2. Background

`chat_threads.title` is a nullable `TEXT` column (max 200 chars). Today it is
populated only when the client passes `{title}` to `POST /chat/threads` or
`PATCH /chat/threads/:tid`. Most threads stay `NULL`, which makes the thread
list view harder to scan ("3 untitled threads from today").

The chat turn handler `processChatTurn` runs one LLM call per turn
(`gemini-2.5-flash-lite`). Auto-titling adds one extra LLM call per thread,
fired once on the user's first message.

The chat route is Pro-gated (402 `upgrade_required` for non-Pro). Auto-title
inherits this gate — only Pro users can produce auto-titled threads, because
they are the only ones who can talk to the assistant at all.

---

## 3. Decisions resolved during brainstorm

| Topic | Decision |
|---|---|
| When to fire | Async fire-and-forget after `processChatTurn` succeeds |
| Trigger condition | `thread.title IS NULL` AND the just-processed message was the FIRST user message in the thread |
| Retry on failure | None. Title stays `NULL`. User can `PATCH` manually. |
| Title length | ≤5 words, prompt-enforced. Defensive cap at 200 chars (DB). |
| Model | `gemini-2.5-flash-lite` (same as chat) via `ai.models.generateContent` |
| Idempotence vs manual PATCH | `UPDATE … WHERE title IS NULL` — manual title wins if it lands first |
| Tier gating | Inherited from chat route (Pro). No separate gate. |
| Streaming | Out of scope. |
| Client-triggered regenerate | Out of scope. |

---

## 4. Architecture

Four pieces, split into two files for test isolation:

**(a) Pure cleanup function** in `apps/api/src/chat/auto-title.ts`:
```typescript
export function cleanTitle(raw: string): string | null;
```
- First non-empty line of `raw`.
- Strip surrounding paired single or double quotes.
- Trim whitespace.
- If the result is empty → `null`.
- Else: hard cap at 200 chars (DB column max), return the cap-truncated value.

This is the only piece with non-trivial logic, so it gets its own pure
function + unit tests.

**(b) LLM call** in a separate module `apps/api/src/chat/auto-title-llm.js`:
```typescript
export async function callTitleLLM(env: Env, firstMessageText: string): Promise<string>;
```
- Build the prompt (see §6).
- Call `gemini-2.5-flash-lite` via the same google-genai client used by
  `processChatTurn`. Truncate the user message to 500 chars before sending.
- Returns the raw `resp.text ?? ""`.
- Errors propagate (caller wraps).

Splitting the LLM call into its own module makes it trivially mockable in
integration tests via `vi.mock("../src/chat/auto-title-llm.js")`.

**(c) Async orchestrator** in `apps/api/src/chat/auto-title.ts`:
```typescript
export async function generateAndPersistThreadTitle(
  env: Env,
  workspaceId: string,
  threadId: string,
  firstMessageText: string,
): Promise<void>;
```
- Calls `callTitleLLM`.
- Pipes raw response through `cleanTitle`.
- If `cleanTitle` returns non-null, executes the conditional UPDATE
  (`WHERE id = $1 AND "workspaceId" = $2 AND title IS NULL`).
- All errors caught and logged via `console.warn` with `{ workspaceId,
  threadId }` context — never thrown.

**(d) Wiring** in `apps/api/src/routes/chat.ts`, `POST /workspaces/:wsId/chat/threads/:tid/messages`:

After `processChatTurn` resolves successfully, before sending the HTTP
response, the handler checks:

1. Fetch (or have in scope) the thread row to confirm `title IS NULL`.
2. Count `chat_messages WHERE threadId = ? AND author = 'user'`. If `== 1`,
   this was the first user message.

If both conditions hold, the handler fires:
```typescript
void generateAndPersistThreadTitle(env, workspaceId, threadId, firstMessageText)
  .catch(() => { /* swallowed — function logs internally */ });
```

The HTTP response is sent immediately afterwards. The Promise continues on
the Node event loop independent of the request.

---

## 5. Trigger detection (concrete pseudo-code)

Inside the messages handler, after `processChatTurn` returns and after the
new user + assistant messages have been persisted:

```typescript
const thread = await prisma.chatThread.findUnique({
  where: { id: threadId },
  select: { title: true, workspaceId: true },
});
if (thread && thread.title === null && thread.workspaceId === workspaceId) {
  const userMsgCount = await prisma.chatMessage.count({
    where: { threadId, author: "user" },
  });
  if (userMsgCount === 1) {
    void generateAndPersistThreadTitle(
      env, workspaceId, threadId, parsed.data.text,
    ).catch(() => {});
  }
}
```

The two queries cost <1ms on Postgres and run after the chat response is
already computed — they are not in the latency-critical path. They run
synchronously *before* the HTTP response is sent (so the `void` Promise has
already been registered) but the actual LLM call inside the async function
happens after the response is on its way back.

---

## 6. Prompt

System instruction (constant string):
```
You generate concise titles for chat conversations.
Output a single-line title of at most 5 words in the same language as the user's message.
No quotes, no markdown, no trailing punctuation.
```

User content: the first user message text, truncated to 500 chars:
```typescript
const userPrompt = firstMessageText.slice(0, 500);
```

The call uses the same `ai.models.generateContent` shape as `processChatTurn`:
```typescript
const resp = await ai.models.generateContent({
  model: env.CHAT_MODEL ?? "gemini-2.5-flash-lite",
  contents: [{ role: "user", parts: [{ text: userPrompt }] }],
  config: { systemInstruction: SYSTEM_INSTRUCTION },
});
const raw = resp.text ?? "";
```

No tools, no function-calling. Plain text-out.

---

## 7. Files

- **Create** `apps/api/src/chat/auto-title.ts` — `cleanTitle` + `generateAndPersistThreadTitle`.
- **Create** `apps/api/src/chat/auto-title-llm.ts` — `callTitleLLM` (separate module so integration tests can mock it cleanly).
- **Modify** `apps/api/src/routes/chat.ts` — append trigger logic at end of `POST /workspaces/:wsId/chat/threads/:tid/messages` handler.
- **Create** `apps/api/tests/chat.auto-title.unit.test.ts` — pure-function `cleanTitle` cases.
- **Create** `apps/api/tests/chat.auto-title.test.ts` — integration: trigger conditions, DB update, idempotence, error path. Mocks `callTitleLLM`.

No schema changes. No new dependencies.

---

## 8. Tests

### 8.1 `chat.auto-title.unit.test.ts` (~8 cases)

```typescript
import { describe, it, expect } from "vitest";
import { cleanTitle } from "../src/chat/auto-title.js";

describe("cleanTitle", () => {
  it("trims whitespace", () => {
    expect(cleanTitle("  Coffee 카테고리 추가  ")).toBe("Coffee 카테고리 추가");
  });
  it("strips matched double quotes", () => {
    expect(cleanTitle('"Coffee 카테고리 추가"')).toBe("Coffee 카테고리 추가");
  });
  it("strips matched single quotes", () => {
    expect(cleanTitle("'Coffee 카테고리'")).toBe("Coffee 카테고리");
  });
  it("takes first non-empty line", () => {
    expect(cleanTitle("Coffee 카테고리\nSecond line")).toBe("Coffee 카테고리");
  });
  it("returns null for empty input", () => {
    expect(cleanTitle("")).toBeNull();
  });
  it("returns null for whitespace-only input", () => {
    expect(cleanTitle("   \n\t")).toBeNull();
  });
  it("caps at 200 chars (DB column max)", () => {
    expect(cleanTitle("a".repeat(250))).toHaveLength(200);
  });
  it("returns null when nothing remains after quote stripping", () => {
    expect(cleanTitle('""')).toBeNull();
  });
});
```

### 8.2 `chat.auto-title.test.ts` (~5 cases)

Integration tests use a mocked LLM call (since the real path uses Gemini
and we don't want quota dependency or non-determinism). Mock strategy: the
`callTitleLLM(env, text): Promise<string>` step is an internal export of
`auto-title.ts`. Tests use `vi.mock` to replace it.

```typescript
// Sketch — actual implementer fills in seed boilerplate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  generateAndPersistThreadTitle,
  // for mocking purposes
} from "../src/chat/auto-title.js";

vi.mock("../src/chat/auto-title-llm.js", () => ({
  callTitleLLM: vi.fn(),
}));

import { callTitleLLM } from "../src/chat/auto-title-llm.js";

describe("[plan 1e-title] auto thread title", () => {
  // ...beforeEach: create user, workspace, thread (title=null), env stub

  it("persists a cleaned title from the LLM result on first message", async () => {
    (callTitleLLM as any).mockResolvedValue("Coffee 카테고리 추가");
    await generateAndPersistThreadTitle(env, workspaceId, threadId, "Coffee 카테고리 만들어줘");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBe("Coffee 카테고리 추가");
  });

  it("does NOT overwrite a manually-set title", async () => {
    await prisma.chatThread.update({ where: { id: threadId }, data: { title: "Manual" } });
    (callTitleLLM as any).mockResolvedValue("Auto Title");
    await generateAndPersistThreadTitle(env, workspaceId, threadId, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBe("Manual");
  });

  it("swallows LLM errors and leaves title NULL", async () => {
    (callTitleLLM as any).mockRejectedValue(new Error("rate-limit"));
    await generateAndPersistThreadTitle(env, workspaceId, threadId, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBeNull();
  });

  it("leaves title NULL when cleanTitle returns null (whitespace LLM output)", async () => {
    (callTitleLLM as any).mockResolvedValue("   \n   ");
    await generateAndPersistThreadTitle(env, workspaceId, threadId, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBeNull();
  });

  it("respects cross-workspace boundary (wrong workspaceId → no update)", async () => {
    (callTitleLLM as any).mockResolvedValue("Should Not Land");
    await generateAndPersistThreadTitle(env, "wrong-ws-id", threadId, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBeNull();
  });
});
```

### 8.3 Wiring

The HTTP-route-level integration (chat route fires the async function) is
NOT covered by an automated test in this plan. Reasons:
- The handler change is small (~10 lines, two queries + one `void` call)
  and is clearly readable in the routes diff.
- An end-to-end test would need either a real LLM call (quota cost,
  non-deterministic) or a deep mock chain (Fastify + Prisma + Gemini)
  whose maintenance cost exceeds the value.
- The function-level integration tests in §8.2 prove the function's
  contract under every relevant input; the wiring is mechanical.

The spec reviewer is responsible for confirming the trigger conditions in
the routes diff match §5 line-by-line.

---

## 9. Acceptance criteria

This plan is complete when:

1. `cleanTitle` exists, pure, with 8 unit tests passing.
2. `generateAndPersistThreadTitle` exists, swallows errors, UPDATEs with the
   `WHERE title IS NULL` idempotence gate.
3. `chat.ts` POST messages handler fires the async function only when
   `thread.title IS NULL` AND `userMsgCount === 1`.
4. The 5 integration cases pass under a mocked LLM.
5. Full API suite still passes (baseline 62 files / 515 tests → expect
   ~64 files / ~528 tests).
6. No new dependency added to `package.json`.

---

## 10. Excluded scope

- Re-titling on later messages.
- Client-triggered regenerate endpoint.
- Streaming title generation (SSE).
- Multi-language detection logic — the prompt asks the LLM to mirror the
  user's language and that's enough.
- Retry on LLM failure.
- A/B testing prompt variants.
- UI changes (user iterating separately).
- Title quality evaluation framework.

---

## 11. Follow-up candidates

- **Plan 1E-title-rev:** `POST /chat/threads/:tid/title/generate` for
  client-triggered regenerate.
- **Plan 1E-title-stream:** SSE-stream the title so the UI can render it
  the moment it's generated.
- **Plan 1E-title-quality:** A/B test prompt variants against a labeled
  dataset.
- **Plan 1E-title-locale:** Honor `User.locale` explicitly if the LLM ever
  starts producing wrong-language output.

---

## 12. Known limitations

- **Gemini free-tier quota** is 10 req/min, 20 req/day for the dev account.
  Each first message now consumes one additional title call, halving the
  chat-turn budget in dev. Pro users use separate billing and are not
  affected.
- **Late title arrival.** If the user refreshes the thread list within
  ~200ms of the first message response, the title may still be NULL. Next
  refresh shows it. UX-acceptable; no client-side polling is added.
- **Prompt drift.** If the LLM ignores the "5 words" instruction and
  returns long sentences, the 200-char DB cap still saves us — but the
  thread list will show a long entry. The UI is expected to truncate
  display; this plan does not.
