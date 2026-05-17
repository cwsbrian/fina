# Plan 1E-title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-generate a concise (≤5 word) title for each new chat thread by calling Gemini once, async fire-and-forget, on the user's first message. Title appears on the next thread-list refresh; the chat response is not delayed.

**Architecture:** A pure `cleanTitle` function handles quote/whitespace stripping with a 200-char DB cap. A separate `callTitleLLM` module wraps `ai.models.generateContent` so integration tests can `vi.mock` it. An orchestrator `generateAndPersistThreadTitle` pipes them together, swallows errors, and writes via `UPDATE … WHERE title IS NULL` so a manual PATCH always wins. The chat messages route fires this orchestrator via `void` after `processChatTurn` succeeds and only when `thread.title IS NULL` and the just-stored user message is the thread's first.

**Tech Stack:** TypeScript ESM monorepo, Fastify, Prisma + Postgres on 5433, Vitest (singleFork), `@google/genai`.

**Spec:** [`docs/superpowers/specs/2026-05-16-plan-1e-title-design.md`](../specs/2026-05-16-plan-1e-title-design.md)

**Worktree:** This plan should be implemented in an isolated worktree branched from main. The subagent-driven-development skill will set this up via `EnterWorktree`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/chat/auto-title.ts` | Pure `cleanTitle` + orchestrator `generateAndPersistThreadTitle` |
| `apps/api/src/chat/auto-title-llm.ts` | `callTitleLLM(env, text)` — wraps the Gemini call so tests can mock it |
| `apps/api/src/routes/chat.ts` | Trigger after `processChatTurn` in POST messages handler |
| `apps/api/tests/chat.auto-title.unit.test.ts` | 8 pure-function `cleanTitle` cases |
| `apps/api/tests/chat.auto-title.test.ts` | 5 integration cases with mocked `callTitleLLM` |

No schema changes. No new dependencies.

---

## Pre-flight Sanity Check

From the worktree root:

```bash
docker ps --filter name=fina-postgres-dev --format "{{.Names}}: {{.Status}}"
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy
pnpm --filter @fina/api exec prisma generate
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** `fina-postgres-dev: Up …`. Both `db:deploy` report "No pending migrations". Test suite: `62 passed / 515 passed`.

If the suite is not at baseline, stop and report — do NOT start implementation on a broken baseline.

---

## Task 1: `cleanTitle` pure function (TDD)

**Files:**
- Create: `apps/api/tests/chat.auto-title.unit.test.ts`
- Create: `apps/api/src/chat/auto-title.ts`

### 1.1 Write the failing test

- [ ] **Step 1: Create `apps/api/tests/chat.auto-title.unit.test.ts`**

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

  it("skips empty leading lines before taking first non-empty line", () => {
    expect(cleanTitle("\n\n  Coffee 카테고리  \nLater")).toBe("Coffee 카테고리");
  });

  it("returns null for empty input", () => {
    expect(cleanTitle("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(cleanTitle("   \n\t")).toBeNull();
  });

  it("returns null when nothing remains after quote stripping", () => {
    expect(cleanTitle('""')).toBeNull();
  });

  it("caps at 200 chars (DB column max)", () => {
    expect(cleanTitle("a".repeat(250))).toHaveLength(200);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (export missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.auto-title.unit.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** error citing missing module or missing export.

### 1.2 Implement

- [ ] **Step 3: Create `apps/api/src/chat/auto-title.ts` with `cleanTitle` only (orchestrator added in Task 3)**

```typescript
const MAX_LEN = 200; // matches chat_threads.title TEXT(200) cap

// Pure: First non-empty line, strip matched outer quotes, trim, cap to MAX_LEN.
// Returns null if nothing meaningful remains.
export function cleanTitle(raw: string): string | null {
  if (!raw) return null;
  let line = "";
  for (const candidate of raw.split("\n")) {
    if (candidate.trim().length > 0) {
      line = candidate;
      break;
    }
  }
  let s = line.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  if (s.length === 0) return null;
  if (s.length > MAX_LEN) return s.slice(0, MAX_LEN);
  return s;
}
```

- [ ] **Step 4: Run — expect PASS (9/9)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.auto-title.unit.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** `Tests  9 passed (9)`.

### 1.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/auto-title.ts apps/api/tests/chat.auto-title.unit.test.ts
git commit -m "feat(plan 1e-title): cleanTitle pure helper"
```

---

## Task 2: `callTitleLLM` module

**Files:**
- Create: `apps/api/src/chat/auto-title-llm.ts`

Why a separate module: integration tests in Task 5 use `vi.mock("../src/chat/auto-title-llm.js")` to replace this single function with a stub. If `cleanTitle` and the LLM call lived in the same module the mock would also overwrite `cleanTitle`, breaking the orchestrator's logic.

No tests for this file directly — it is a thin wrapper. The orchestrator (Task 3) tests against mocks of this module, and the spec calls this out (§8.3).

### 2.1 Implement

- [ ] **Step 1: Create `apps/api/src/chat/auto-title-llm.ts`**

```typescript
import { GoogleGenAI } from "@google/genai";
import type { Env } from "../env.js";

const SYSTEM_INSTRUCTION =
  "You generate concise titles for chat conversations.\n" +
  "Output a single-line title of at most 5 words in the same language as the user's message.\n" +
  "No quotes, no markdown, no trailing punctuation.";

const MAX_PROMPT_CHARS = 500;

// Calls Gemini once with the SYSTEM_INSTRUCTION + the (truncated) first user
// message. Returns the raw text. Errors propagate; the orchestrator catches.
export async function callTitleLLM(env: Env, firstMessageText: string): Promise<string> {
  const userPrompt = firstMessageText.slice(0, MAX_PROMPT_CHARS);
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const model = env.CHAT_MODEL ?? "gemini-2.5-flash-lite";
  const resp = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config: { systemInstruction: SYSTEM_INSTRUCTION },
  });
  return resp.text ?? "";
}
```

- [ ] **Step 2: Run the existing test suite — expect no regression (62 files / 515 tests)**

```bash
pnpm --filter @fina/api exec vitest run --reporter=basic 2>&1 | tail -5
```

The new file is not referenced anywhere yet, so the suite should be unchanged in count and all green.

### 2.2 Commit

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/chat/auto-title-llm.ts
git commit -m "feat(plan 1e-title): callTitleLLM — Gemini wrapper for title generation"
```

---

## Task 3: `generateAndPersistThreadTitle` orchestrator (TDD via Task 5 integration)

**Files:**
- Modify: `apps/api/src/chat/auto-title.ts` (append the orchestrator)

The orchestrator's behavior is exercised by Task 5's integration tests. Task 3 is the minimal "make Task 5's first case pass" step — we'll write its body now and verify it boots cleanly via a syntax-only test run.

### 3.1 Append the orchestrator

- [ ] **Step 1: Append to `apps/api/src/chat/auto-title.ts`**

The file currently has `cleanTitle` only. Add the orchestrator below it, plus the imports it needs at the top:

```typescript
import { prisma } from "../db.js";
import { callTitleLLM } from "./auto-title-llm.js";
import type { Env } from "../env.js";
```

```typescript
// Fire-and-forget. Caller does `void generateAndPersistThreadTitle(...)`.
// On any failure, logs via console.warn and resolves — never throws.
// The DB update uses `WHERE title IS NULL` so a manual PATCH during the
// async window is preserved.
export async function generateAndPersistThreadTitle(
  env: Env,
  workspaceId: string,
  threadId: string,
  firstMessageText: string,
): Promise<void> {
  try {
    const raw = await callTitleLLM(env, firstMessageText);
    const cleaned = cleanTitle(raw);
    if (cleaned === null) return;
    await prisma.chatThread.updateMany({
      where: { id: threadId, workspaceId, title: null },
      data: { title: cleaned, updatedAt: new Date() },
    });
  } catch (err) {
    console.warn("auto-title failed", { workspaceId, threadId, err });
  }
}
```

Notes:
- `updateMany` is the right Prisma call when the WHERE clause includes a column predicate beyond the primary key (`title: null`). It returns `{ count }` and never throws on zero matches. (`update` with `where: { id, title: null }` would throw — wrong semantics here.)
- `updatedAt: new Date()` — explicit because `update` automatically bumps `@updatedAt` but `updateMany` does not. (Verify in Task 5: assert `updatedAt` changes after title lands.)

- [ ] **Step 2: Run the existing test suite — expect no regression**

```bash
pnpm --filter @fina/api exec vitest run --reporter=basic 2>&1 | tail -5
```

The orchestrator is wired up but not called from anywhere yet, so the suite count is unchanged.

### 3.2 Commit

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/chat/auto-title.ts
git commit -m "feat(plan 1e-title): generateAndPersistThreadTitle orchestrator"
```

---

## Task 4: Wire trigger into the messages route

**Files:**
- Modify: `apps/api/src/routes/chat.ts` (POST `/workspaces/:id/chat/threads/:tid/messages` handler)

### 4.1 Add the trigger after `processChatTurn`

The handler currently flows: load thread → insert user message → call `processChatTurn` → insert assistant message → return response. Insert the trigger between the assistant insert and the return.

- [ ] **Step 1: Add the import at the top of `apps/api/src/routes/chat.ts`**

Find the existing imports (around line 1-10) and add:

```typescript
import { generateAndPersistThreadTitle } from "../chat/auto-title.js";
```

- [ ] **Step 2: Add the trigger block**

After the `assistantMessage = await prisma.$transaction(...)` block and BEFORE the `return { threadId, userMessage, assistantMessage, toolCalls }` block in the POST messages handler, insert:

```typescript
      // Plan 1E-title: auto-generate a concise title on the first user
      // message. Fire-and-forget — never delays the response, never propagates
      // errors. The orchestrator's DB write is gated on `title IS NULL` so a
      // manual PATCH during the async window wins.
      if (thread.title === null) {
        const userMsgCount = await prisma.chatMessage.count({
          where: { threadId: thread.id, role: "user" },
        });
        if (userMsgCount === 1) {
          void generateAndPersistThreadTitle(
            app.fina.env,
            thread.workspaceId,
            thread.id,
            parsed.data.text,
          ).catch(() => {
            /* orchestrator logs internally */
          });
        }
      }
```

`thread` is already loaded earlier in the handler (`const thread = await threadsService.findOwned(...)`); we reuse `thread.title` and `thread.workspaceId`. `parsed.data.text` is the first message text already validated by `MessageBody`.

- [ ] **Step 3: Run the existing chat route tests — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run "tests/chat.routes" --reporter=basic 2>&1 | tail -10
```

**Expected:** all existing route tests still pass. The trigger fires only when title is null AND it's the first user message; existing tests either seed multi-message threads or work with non-null titles, so they shouldn't see new behavior. If a test fails, read the failure — it likely means the route's response shape changed (it should NOT — we didn't modify the return).

- [ ] **Step 4: Run the full API suite**

```bash
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** still 62 files / 515 tests pass. The trigger fires asynchronously and the `void` Promise never settles within the test boundary (because `callTitleLLM` would need a real Gemini key, which tests don't have — but even so the catch swallows any rejection). Pre-existing chat tests that don't mock `auto-title-llm` will silently log a warning when the orchestrator's promise eventually fails. That's acceptable and matches the spec.

### 4.2 Commit

- [ ] **Step 5: Commit**

```bash
git diff --staged --stat
git add apps/api/src/routes/chat.ts
git commit -m "feat(plan 1e-title): wire auto-title trigger into messages route"
```

---

## Task 5: Integration tests (TDD, mocks `callTitleLLM`)

**Files:**
- Create: `apps/api/tests/chat.auto-title.test.ts`

### 5.1 Write the integration test

- [ ] **Step 1: Create `apps/api/tests/chat.auto-title.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { generateAndPersistThreadTitle } from "../src/chat/auto-title.js";
import type { Env } from "../src/env.js";

// Mock the LLM call so tests don't hit Gemini.
vi.mock("../src/chat/auto-title-llm.js", () => ({
  callTitleLLM: vi.fn(),
}));

import { callTitleLLM } from "../src/chat/auto-title-llm.js";

const env = {
  GEMINI_API_KEY: "test-key",
  CHAT_MODEL: "gemini-2.5-flash-lite",
} as unknown as Env;

describe("[plan 1e-title] generateAndPersistThreadTitle", () => {
  let workspaceId: string;
  let threadId: string;

  beforeEach(async () => {
    vi.mocked(callTitleLLM).mockReset();
    const stamp = `at-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "AT" } });
    const ws = await prisma.workspace.create({ data: { name: "at-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId: stamp, workspaceId, role: "owner" } });
    const t = await prisma.chatThread.create({ data: { workspaceId, title: null } });
    threadId = t.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    // Membership + ChatThread cascade via workspaceId. The user remains
    // (no FK to workspace deletion); leave it — IDs are random per-test.
  });

  it("persists a cleaned title from the LLM result on first message", async () => {
    vi.mocked(callTitleLLM).mockResolvedValue("Coffee 카테고리 추가");
    await generateAndPersistThreadTitle(env, workspaceId, threadId, "Coffee 카테고리 만들어줘");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBe("Coffee 카테고리 추가");
  });

  it("does NOT overwrite a manually-set title", async () => {
    await prisma.chatThread.update({ where: { id: threadId }, data: { title: "Manual" } });
    vi.mocked(callTitleLLM).mockResolvedValue("Auto Title");
    await generateAndPersistThreadTitle(env, workspaceId, threadId, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBe("Manual");
  });

  it("swallows LLM errors and leaves title NULL", async () => {
    vi.mocked(callTitleLLM).mockRejectedValue(new Error("rate-limit"));
    await generateAndPersistThreadTitle(env, workspaceId, threadId, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBeNull();
  });

  it("leaves title NULL when cleanTitle returns null (whitespace LLM output)", async () => {
    vi.mocked(callTitleLLM).mockResolvedValue("   \n   ");
    await generateAndPersistThreadTitle(env, workspaceId, threadId, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBeNull();
  });

  it("respects cross-workspace boundary (wrong workspaceId → no update)", async () => {
    vi.mocked(callTitleLLM).mockResolvedValue("Should Not Land");
    await generateAndPersistThreadTitle(env, "wrong-ws-id", threadId, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBeNull();
  });
});
```

- [ ] **Step 2: Run the new test — expect PASS (5/5)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.auto-title.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** `Tests  5 passed (5)`.

If a case fails, the most likely cause is the `updateMany` semantics. Re-check that `where: { id: threadId, workspaceId, title: null }` matches the orchestrator's actual code.

### 5.2 Commit

- [ ] **Step 3: Commit**

```bash
git add apps/api/tests/chat.auto-title.test.ts
git commit -m "test(plan 1e-title): integration — orchestrator with mocked LLM"
```

---

## Task 6: Full suite verification + final sanity

**Files:** none (verification only).

### 6.1 Full API suite

- [ ] **Step 1: Run the full suite via nx**

```bash
pnpm nx reset 2>&1 | tail -2
pnpm nx run api:test --skipNxCache 2>&1 | tail -10
```

**Expected:** all test files pass. Count = baseline 62 + 2 new = **64 files**. Tests = baseline 515 + (9 unit + 5 integration) = **529 tests**. ±1-2 acceptable if any existing assertion's structure shifted (none should — this plan adds files, doesn't modify existing tests).

### 6.2 Sanity grep — no leftover stubs

- [ ] **Step 2: Confirm both new files exist and are exported correctly**

```bash
grep -n "export" apps/api/src/chat/auto-title.ts apps/api/src/chat/auto-title-llm.ts
```

**Expected:**
- `auto-title.ts` exports `cleanTitle` and `generateAndPersistThreadTitle`.
- `auto-title-llm.ts` exports `callTitleLLM`.

- [ ] **Step 3: Confirm route wiring**

```bash
grep -n "generateAndPersistThreadTitle" apps/api/src/routes/chat.ts
```

**Expected:** exactly two hits — one in the import line, one in the trigger block.

```bash
grep -n "role: \"user\"" apps/api/src/routes/chat.ts | head -5
```

**Expected:** the count query `where: { threadId: thread.id, role: "user" }` is one of the matches.

### 6.3 No new dependency

- [ ] **Step 4: Confirm `package.json` is unchanged**

```bash
git diff main -- apps/api/package.json package.json
```

**Expected:** no output (unchanged). The spec requires no new dependency.

---

## Self-Review Checklist (after all tasks)

Before handing off to code review:

1. **Spec coverage:** Every spec §4 (a/b/c/d), §5 trigger, §6 prompt, §7 files, §8 tests, §9 acceptance is touched by a task.
2. **No leftover stubs.** Grep in 6.2 returns expected hits only.
3. **All 6 commits** are small, topic-focused (one Task = one commit, except Task 6 which is verification-only and has no commit).
4. **Orchestrator never throws.** Re-read `generateAndPersistThreadTitle` — the entire body is wrapped in `try { … } catch { console.warn(…) }`.
5. **`updateMany` is the right Prisma call** (not `update`) because the WHERE includes `title: null` beyond the primary key.

---

## Known limitations (documented in spec §12)

- Gemini free-tier daily quota (20 req/day): each first message now costs +1 LLM call. Pro users billed separately are unaffected.
- Late title arrival: if the thread list is refreshed within ~200ms of the first message response, the title may still be NULL. Next refresh shows it.
- Prompt drift: if the LLM ignores the "5 words" instruction, the 200-char DB cap still saves us — but the title may be long.

These are listed here so a reviewer doesn't ask "why didn't you also fix X?" — the answer is "Section §12 of the spec."
