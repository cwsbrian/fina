# Plan 1E-chat-foundation — Chat Agent foundation (design)

**Date:** 2026-05-14
**Branch:** `worktree-plan-1e-chat-opus` (Variant A of experiment 2026-05-14-opus-vs-non-opus)
**Builds on:** Plan 1A foundations, Plan 1B-categorize (Gemini SDK already integrated), Plan 1D-tier-enforcement (effectiveTier with plaidItemLimit + tier checks)
**Status:** design / pre-implementation

---

## 1. Goal & Scope

**Goal:** End-to-end working chat agent. A Pro user can send a natural-language message, the assistant calls tools to look at the user's data, and replies with text. Four representative tools demonstrate read + a single safe write.

### 1.1 In scope

- DB: `chat_threads` + `chat_messages` (blocks JSON inline)
- `POST /workspaces/:id/chat/message` — non-streaming, returns assistant text
- `GET /workspaces/:id/chat/thread` — single thread + recent messages
- Tool registry framework (one file per tool, central index)
- **4 representative tools**:
  - `listTransactions({ period?, limit? })` (read)
  - `getSpendingSummary({ period, group_by })` (read, computed)
  - `listCategories()` (read)
  - `categorizeTransaction({ tx_id, category })` (single-row safe write)
- `buildFinancialContext(workspaceId)` — fresh summary injected on each LLM call
- LLM provider: Gemini 2.5 Flash Lite (env-configurable via `CHAT_MODEL`)
- Loop guard: `CHAT_MAX_TOOL_CALLS_PER_TURN` (default 10)
- History window: `CHAT_HISTORY_LIMIT` (default 20 messages)
- Tier gate: Pro only (`effectiveTier.tier !== "pro"` → 402)

### 1.2 Out of scope (future plans)

- Rich blocks rendering + `presentText`/`presentCards`/`presentQuickReplies` tools
- `confirm_card` + dangerous write tools (`addTransaction`, `deleteTransaction`, `addRecurring`, etc.)
- SSE streaming
- Morning ritual generation + push notifications
- The remaining ~17 tools (budget, recurring, schedule, analytics)
- PII redaction layer (master spec §12.2) — basic only for v1
- Lite-tier read-only chat (master spec §13.3) — 1E gates on Pro only

---

## 2. Data Model

Two new tables. No `chat_blocks` table — blocks live as JSON on `chat_messages`.

```prisma
model ChatThread {
  id          String   @id @default(cuid())
  workspaceId String   @unique  // one thread per workspace
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  workspace Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  messages  ChatMessage[]

  @@map("chat_threads")
}

model ChatMessage {
  id        String          @id @default(cuid())
  threadId  String
  role      ChatMessageRole // user | assistant | tool
  // For user/assistant: array of presentation blocks; 1E emits only
  //   [{ type: "text", markdown: "..." }]
  // For tool: array of one record:
  //   [{ type: "tool", toolName, args, result }]
  // Schema is future-proof — `categorize_card`, `confirm_card`, etc. add later
  // without migrating existing rows.
  blocks    Json
  createdAt DateTime        @default(now())

  thread ChatThread @relation(fields: [threadId], references: [id], onDelete: Cascade)

  @@index([threadId, createdAt])
  @@map("chat_messages")
}

enum ChatMessageRole {
  user
  assistant
  tool
}
```

### Design decisions

- **`workspaceId @unique` on `ChatThread`** — enforces "1 workspace = 1 thread" invariant at the DB layer. Service code uses `prisma.chatThread.upsert({ where: { workspaceId } })` to get-or-create.
- **`role: tool`** — tool calls + results are persisted as their own messages. Easy to reconstruct LLM history and to surface tool usage in the UI later.
- **`blocks Json`** — 1E emits one-element arrays only, but the array shape lets future block types stack inside a single assistant message (e.g. text + categorize_card + text) without schema changes.

### Migration

```bash
pnpm --filter @fina/api exec prisma migrate dev --name add_chat
```

The generated SQL creates the two tables + new enum. No `IF NOT EXISTS` needed (this is the initial creation, not an `ALTER TYPE ADD VALUE`).

---

## 3. API Endpoints

### 3.1 `POST /workspaces/:id/chat/message`

**Request:**

```ts
{ text: string }   // min 1 char, max 4000
```

**Response 200:**

```ts
{
  threadId: string;
  userMessage:      { id, role: "user",      blocks: [{ type: "text", markdown }], createdAt };
  assistantMessage: { id, role: "assistant", blocks: [{ type: "text", markdown }], createdAt };
  toolCalls: { toolName: string; args: unknown; result: unknown }[];   // audit trail for the turn
}
```

**Flow:**

```
1. requireWorkspaceContext (auth + workspace membership)
2. effectiveTier(userId).tier === "pro"? else 402 upgrade_required
3. Validate body (zod)
4. chatThread.upsert({ where: { workspaceId } })
5. Insert user message (role=user, blocks=[{type:"text", markdown:text}])
6. processChatTurn(env, thread, userId) → { assistantText, toolCalls }
7. Insert assistant message (role=assistant, blocks=[{type:"text", markdown:assistantText}])
8. Return all four in response
```

### 3.2 `GET /workspaces/:id/chat/thread`

**Response 200:**

```ts
{
  threadId: string;
  messages: { id; role; blocks; createdAt }[];   // oldest first, last 100
}
```

If no thread exists yet, the endpoint upserts and returns an empty `messages: []`.

### 3.3 Error codes

| HTTP | Code | Trigger |
|---|---|---|
| 400 | `invalid_body` | text empty / >4000 chars / missing |
| 402 | `upgrade_required` | `tier !== "pro"` |
| 403 | `workspace_mismatch` | path :id ≠ ctx workspace |
| 500 | `chat_provider_error` | Gemini SDK throws |

---

## 4. Tool Registry

### 4.1 Tool interface — `apps/api/src/chat/tools/types.ts`

```ts
import { z } from "zod";
import type { Env } from "../../env.js";

export type ToolContext = {
  env: Env;
  workspaceId: string;
  userId: string;
};

export type ToolDef<TArgs = unknown, TResult = unknown> = {
  name: string;
  description: string;
  args: z.ZodType<TArgs>;
  run: (ctx: ToolContext, args: TArgs) => Promise<TResult>;
};
```

### 4.2 File layout

```
apps/api/src/chat/
  tools/
    types.ts                       # ToolDef + ToolContext
    list-transactions.ts           # ToolDef
    get-spending-summary.ts        # ToolDef
    list-categories.ts             # ToolDef
    categorize-transaction.ts      # ToolDef
    index.ts                       # export const REGISTRY: ToolDef[] = [...]
```

Each tool file owns: name, description, zod schema, `run()`. No cross-imports between tools.

### 4.3 Gemini adapter — `apps/api/src/chat/gemini-adapter.ts`

Convert zod schemas to JSON Schema for Gemini's `functionDeclarations`:

```ts
import { zodToJsonSchema } from "zod-to-json-schema";

export function toGeminiFunctionDeclarations(tools: ToolDef[]): FunctionDeclaration[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: zodToJsonSchema(t.args, { target: "openAi" }),
  }));
}
```

**New dependency:** `zod-to-json-schema` (zero-dep, ~30KB).

### 4.4 Dispatcher — `apps/api/src/chat/dispatcher.ts`

```ts
export async function dispatchTool(
  ctx: ToolContext,
  toolName: string,
  rawArgs: unknown,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const tool = REGISTRY.find((t) => t.name === toolName);
  if (!tool) return { ok: false, error: `unknown_tool: ${toolName}` };

  const parsed = tool.args.safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: `invalid_args: ${parsed.error.message}` };

  try {
    const result = await tool.run(ctx, parsed.data);
    return { ok: true, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 500) };
  }
}
```

The dispatcher never throws. Errors become `{ ok: false, error }` and are fed back to the LLM as a `functionResponse` with an `error` field.

### 4.5 Tool reference

Names + zod arg schemas (descriptions inform the LLM):

```ts
// listTransactions
args: z.object({
  period: z.enum(["today", "this_week", "this_month", "last_month"]).optional(),
  limit:  z.number().int().positive().max(50).optional(),
});

// getSpendingSummary
args: z.object({
  period:   z.enum(["this_week", "this_month", "last_month"]),
  group_by: z.enum(["category", "merchant", "day"]).optional(),
});

// listCategories
args: z.object({});

// categorizeTransaction
args: z.object({
  tx_id:    z.string().min(1),
  category: z.string().min(1),   // matched by name within workspace, case-insensitive
});
```

Tools validate workspace ownership via `ctx.workspaceId` on every query. Cross-workspace `tx_id` → tool throws → dispatcher returns `{ error }` → LLM apologizes.

---

## 5. Chat Turn Engine

### 5.1 Financial context — `apps/api/src/chat/context.ts`

```ts
export async function buildFinancialContext(workspaceId: string): Promise<string> {
  const [txCount, latestTx, categories] = await Promise.all([
    prisma.transaction.count({ where: { workspaceId } }),
    prisma.transaction.findFirst({
      where: { workspaceId },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    }),
    prisma.category.count({ where: { workspaceId } }),
  ]);

  return [
    `## Current state`,
    `- Total transactions: ${txCount}`,
    latestTx
      ? `- Latest transaction date: ${latestTx.occurredAt.toISOString().slice(0, 10)}`
      : `- No transactions yet`,
    `- Categories defined: ${categories}`,
  ].join("\n");
}
```

Intentionally minimal for 1E (no merchant names, no amounts — privacy-favorable). Future plans extend with budget/recurring/scheduled summaries.

### 5.2 System prompt

```ts
const SYSTEM_PROMPT = `You are Fina, a personal-finance assistant for Canadian users. You help users
understand their spending, categorize transactions, and plan their budgets.

Style:
- Concise. Short sentences. No bullet lists unless asked.
- Use Korean if the user writes in Korean; otherwise English.
- Currency is CAD unless stated.

When you need data, call a tool. Don't make up transactions, balances, or categories.
When a tool returns { error: ... }, briefly explain the issue and suggest what to try.

Don't ask permission to look up data — just call the tool and show the result.`;
```

### 5.3 History conversion — Prisma rows → Gemini `contents`

```ts
function toGeminiHistory(messages: ChatMessage[]): GeminiContent[] {
  return messages.map((m) => {
    const blocks = m.blocks as Block[];
    if (m.role === "user") {
      return { role: "user", parts: [{ text: blocks[0].markdown }] };
    }
    if (m.role === "assistant") {
      return { role: "model", parts: [{ text: blocks[0].markdown }] };
    }
    // tool result — Gemini wants a user-role functionResponse part
    const t = blocks[0] as ToolBlock;
    return {
      role: "user",
      parts: [{ functionResponse: { name: t.toolName, response: t.result } }],
    };
  });
}
```

### 5.4 Main loop — `apps/api/src/chat/turn.ts`

```ts
export async function processChatTurn(
  env: Env,
  thread: { id: string; workspaceId: string },
  userId: string,
): Promise<{ assistantText: string; toolCalls: ToolCallRecord[] }> {
  const HISTORY_LIMIT  = env.CHAT_HISTORY_LIMIT          ?? 20;
  const MAX_TOOL_CALLS = env.CHAT_MAX_TOOL_CALLS_PER_TURN ?? 10;
  const MODEL          = env.CHAT_MODEL                  ?? "gemini-2.5-flash-lite";

  const ctx: ToolContext = { env, workspaceId: thread.workspaceId, userId };

  const recent = await prisma.chatMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
  });
  const historyChrono = recent.reverse();

  const sysInstruction = `${SYSTEM_PROMPT}\n\n${await buildFinancialContext(thread.workspaceId)}`;
  const tools = [{ functionDeclarations: toGeminiFunctionDeclarations(REGISTRY) }];

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  let contents = toGeminiHistory(historyChrono);
  const toolCalls: ToolCallRecord[] = [];

  for (let i = 0; i <= MAX_TOOL_CALLS; i++) {
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { systemInstruction: sysInstruction, tools },
    });

    const fc = extractFunctionCall(resp);
    if (!fc) {
      const text = extractText(resp) ?? "";
      return { assistantText: text, toolCalls };
    }

    if (i === MAX_TOOL_CALLS) {
      console.warn("chat: max tool calls exceeded", { threadId: thread.id, count: i });
      return {
        assistantText: "I couldn't complete that — try a simpler request.",
        toolCalls,
      };
    }

    const dispatch = await dispatchTool(ctx, fc.name, fc.args);
    const result = dispatch.ok ? dispatch.result : { error: dispatch.error };
    toolCalls.push({ toolName: fc.name, args: fc.args, result });

    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        role: "tool",
        blocks: [{ type: "tool", toolName: fc.name, args: fc.args, result }],
      },
    });

    contents = [
      ...contents,
      { role: "model", parts: [{ functionCall: { name: fc.name, args: fc.args } }] },
      { role: "user",  parts: [{ functionResponse: { name: fc.name, response: result } }] },
    ];
  }

  // Unreachable — the loop bound includes the apology path
  return { assistantText: "", toolCalls };
}
```

---

## 6. Concurrency, Errors, Privacy

### 6.1 Concurrency

- **Same workspace, two simultaneous user messages:** both insert user messages; each turn loads its own history. The second turn sees the first's user message. Acceptable at dogfood scale; no advisory lock.
- **Tool execution:** Prisma's connection pool handles concurrency. `categorizeTransaction` calls `prisma.transaction.update` (atomic single-row write).

### 6.2 Error handling

| Failure | Response |
|---|---|
| Gemini API throws (network, 5xx) | 500 `chat_provider_error`. User message persisted; assistant message NOT persisted. Log sanitized error. |
| Gemini returns neither text nor functionCall | Treat as empty turn — `assistantText: ""`. Log warning. |
| Tool throws | Caught in `dispatcher.ts` → `{ ok: false, error }` → LLM sees `{ error }` in functionResponse |
| `MAX_TOOL_CALLS` exceeded | Apology assistant message. Log warning with thread id. |
| Tier check fails | 402 `upgrade_required` before user message is persisted |

### 6.3 Privacy

**What goes to Gemini per call:**
- System prompt (static)
- Financial context (counts + latest tx date + category count — no PII)
- Recent ≤20 messages (user text, assistant text, tool calls + results)
- Tool definitions

**User data in tool results** (merchant names, amounts, tx IDs) is unavoidable. Acceptable per master spec §12.1 (Gemini is the declared provider; user consents at signup).

**Out of scope:** PII redaction layer (§12.2). Audit log already exists via `role: "tool"` rows.

### 6.4 Tier gate

- Free / expired trial → 402 `upgrade_required` **before** the user message is persisted.
- Lite (future) → also 402; Lite read-only chat is owned by a future plan.
- Pro (incl. active trial) → allowed.

---

## 7. Testing

### 7.1 Unit — Tools

Real DB, no LLM. Seed workspace + transactions, call `tool.run(ctx, args)` directly.

- `chat.tools.list-transactions.test.ts` — period filtering, limit clamp, returned shape
- `chat.tools.categorize-transaction.test.ts` — success, cross-workspace tx_id throws, unknown category throws
- `chat.tools.get-spending-summary.test.ts` — totals per `group_by`
- `chat.tools.list-categories.test.ts` — returns workspace categories only

### 7.2 Unit — Dispatcher

- `chat.dispatcher.test.ts`
  - Known tool + valid args → `{ ok: true, result }`
  - Unknown tool → `{ ok: false, error: "unknown_tool: ..." }`
  - Invalid args (zod fails) → `{ ok: false, error: "invalid_args: ..." }`
  - Tool throws → `{ ok: false, error: <msg> }` (no rethrow)

### 7.3 Unit — Turn engine

`chat.turn.test.ts` with `vi.mock("@google/genai", ...)`:

- LLM returns text immediately → assistant message saved, `toolCalls: []`
- LLM returns 1 functionCall → dispatcher runs → result fed back → LLM returns text → assistant message saved, `toolCalls.length === 1`
- LLM returns 10+ consecutive functionCalls → loop hits `MAX_TOOL_CALLS` → apology assistant text, log warning fires
- Gemini SDK throws → exception propagates (route returns 500)
- Tool dispatcher returns error → LLM sees `{ error }` → mock LLM returns explanatory text

### 7.4 Integration — Route

`chat.routes.test.ts` with `vi.mock("@google/genai", ...)`:

- Free user (expired trial) → POST `/chat/message` → 402 `upgrade_required`, no thread/message rows created
- Pro user → POST `/chat/message` → 200, thread upserted, user+assistant messages persisted, response shape correct
- Second message → reuses existing thread (`workspaceId @unique` invariant)
- Pro user → GET `/chat/thread` → returns thread + messages oldest-first
- Gemini mock throws → 500 `chat_provider_error`, user message NOT persisted

### 7.5 E2E (skip-guarded on `GEMINI_API_KEY`)

`e2e/plan-1e-chat-foundation.spec.ts`:

- Sign up via API → POST `/chat/message` "list my recent transactions" → assert assistant response is non-empty AND `toolCalls` contains a call to `listTransactions`
- POST `/chat/message` "what's my total spending this month" → assert `getSpendingSummary` is among `toolCalls`

Real Gemini call validates: tool schema serialization, function call detection, end-to-end happy path.

### 7.6 Smoke

- `pnpm smoke:api` with `GEMINI_API_KEY` set, `CHAT_MODEL=gemini-2.5-flash-lite`
- Sign in via web → POST `/chat/message` via curl
- Verify text response makes sense + DB has user/assistant/tool rows

---

## 8. Open Questions / Risks

| # | Topic | Decision |
|---|---|---|
| 1 | Gemini API quota / rate limits | Free tier ~15 RPM. Dogfood usage is fine. Paid tier for production — out of scope. |
| 2 | `zod-to-json-schema` correctness for Gemini | Library targets OpenAI but Gemini accepts the same JSON Schema subset. Validate during E2E smoke; if Gemini rejects a tool schema, document workaround in a fix-up commit. |
| 3 | Conversation history grows unbounded | Each turn loads `take: 20`. Old rows persist forever — fine at dogfood scale. TTL cleanup is a future plan. |
| 4 | Token-level context limit | Capped at 20 messages, not tokens. Tool `limit` defaults are conservative (20 tx, 10 categories) to prevent runaway results. If Gemini errors on context length, surface as `chat_provider_error`. |
| 5 | Streaming UX | Non-streaming for 1E. Mobile shows spinner during full loop. Streaming = future plan. |
| 6 | Multi-member workspace concurrency | Two members posting simultaneously → each turn loads its own snapshot of history. Acceptable; chat is shared per spec §6. |
| 7 | `@google/genai` SDK version | Same version used by `apps/api/src/categorize/`. No new SDK risk. |
| 8 | Tool descriptions in English only | LLM may respond in Korean but tool descriptions are English. Verified safe by existing categorize service usage. |
| 9 | User has 0 transactions | Tool returns empty list. System prompt's "don't make up data" rule applies — LLM should say "you don't have any transactions yet". |
| 10 | `categorizeTransaction` category match | Case-insensitive match by `name` within workspace. Not found → throws → LLM tells user to call `listCategories` first. |
| 11 | Chat audit trail | `role: "tool"` rows already provide per-call audit. No separate audit log needed for 1E. |

---

## 9. Acceptance criteria

- [ ] `pnpm --filter @fina/api exec prisma migrate dev --name add_chat` succeeds; `chat_threads` and `chat_messages` tables + `ChatMessageRole` enum exist in DB.
- [ ] Free user → POST `/chat/message` → 402 `upgrade_required`.
- [ ] Pro user → POST `/chat/message` (text "hi") → 200, assistant text response, thread + user + assistant messages persisted.
- [ ] Pro user → POST `/chat/message` ("list my transactions") → triggers `listTransactions` tool call (verified in response `toolCalls`).
- [ ] Tool throw → LLM receives `{ error }`, produces a graceful explanation.
- [ ] `MAX_TOOL_CALLS` exceeded → apology assistant message; warning logged.
- [ ] GET `/chat/thread` returns the workspace's single thread with messages oldest-first.
- [ ] All existing 288 API tests stay green; new tests pass.
- [ ] E2E (skip-guarded on `GEMINI_API_KEY`): real Gemini conversation completes with at least one tool call.
