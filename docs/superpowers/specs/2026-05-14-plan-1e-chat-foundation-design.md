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
- Three new optional `Env` keys added to `apps/api/src/env.ts:3-53` (match existing `CATEGORIZE_BATCH_MAX` convention — `.optional()` not `.default()` so test env literals stay clean; defaults applied at use-site with `?? N`):
  ```ts
  CHAT_MODEL: z.string().optional(),                            // default "gemini-2.5-flash-lite"
  CHAT_HISTORY_LIMIT: z.coerce.number().int().positive().optional(),     // default 20
  CHAT_MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().positive().optional(), // default 10
  ```
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

The `Workspace` model gets a new back-relation field — Prisma requires both sides of every relation. Add to the existing `Workspace` block in `apps/api/prisma/schema.prisma:89` alongside the other arrays (`memberships`, `plaidItems`, etc.):

```prisma
model Workspace {
  // … existing fields …
  chatThreads      ChatThread[]
}
```

```prisma
model ChatThread {
  id          String         @id @default(cuid())
  workspaceId String
  type        ChatThreadType @default(adhoc)   // adhoc = the user's chat; daily = morning-ritual brief
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt

  workspace Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  messages  ChatMessage[]

  // Forward-compat for the morning-ritual plan: each workspace will have one
  // adhoc thread + one daily-brief thread. 1E only creates the adhoc thread.
  @@unique([workspaceId, type])
  @@map("chat_threads")
}

enum ChatThreadType {
  adhoc
  daily
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

- **`@@unique([workspaceId, type])` on `ChatThread`** — enforces "1 thread per (workspace, type)" at the DB layer. 1E always uses `type: adhoc`. Service code: `prisma.chatThread.upsert({ where: { workspaceId_type: { workspaceId, type: "adhoc" } } })` to get-or-create. The morning-ritual plan adds `type: daily` rows without migrating existing data.
- **`role: tool`** — tool calls + results are persisted as their own messages. The `blocks` JSON includes both `args` AND `result` so the row alone is sufficient to reconstruct both Gemini parts (`functionCall` + `functionResponse`) on rehydration. See §5.3.
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
1. requireWorkspaceContext(req, app, { requiredRole: "editor" }) — POSTing a chat message
   is a write that may invoke `categorizeTransaction`, so editor is the minimum role.
   Throws: 400 missing_workspace_header, 404 no_membership, 403 insufficient_role (viewer).
2. Compare ctx.membership.workspaceId === params.id; mismatch → 400 workspace_mismatch
3. effectiveTier(userId).tier === "pro"? else 402 upgrade_required
4. Validate body (zod) — text is required, 1..4000 chars
5. chatThread.upsert({
     where: { workspaceId_type: { workspaceId, type: "adhoc" } },
     create: { workspaceId, type: "adhoc" },
     update: {},
   })
6. Insert user message (role=user, blocks=[{type:"text", markdown:text}])
7. processChatTurn(env, thread, userId) → { assistantText, toolCalls }
8. Insert assistant message (role=assistant, blocks=[{type:"text", markdown:assistantText}])
9. Return all four in response
```

### 3.2 `GET /workspaces/:id/chat/thread`

Authn/authz: `requireWorkspaceContext(req, app, { requiredRole: "viewer" })` — read-only.

**Response 200:**

```ts
{
  threadId: string;
  messages: { id; role; blocks; createdAt }[];   // oldest first, last 100
}
```

If no thread exists yet, the endpoint upserts and returns an empty `messages: []`.

**Design note (viewer + write side-effect):** the upsert creates a thread row from a `viewer`-role GET — a side-effect from a read endpoint. Accepted because (a) the row is an empty container with no content, (b) `ChatThread` cascades on `Workspace` delete so it doesn't outlive membership-revoke + workspace-delete, and (c) avoiding the upsert here would force the client to handle a "no thread yet" empty state separately, which is more API surface area for no user-visible gain. The morning-ritual plan reuses the same pattern for `type: daily`.

### 3.3 Error codes

| HTTP | Code | Trigger |
|---|---|---|
| 400 | `invalid_body` | text empty / >4000 chars / missing |
| 400 | `missing_workspace_header` | `X-Workspace-Id` header missing (raised by `requireWorkspaceContext`) |
| 400 | `workspace_mismatch` | path `:id` ≠ ctx `workspaceId` (matches existing routes — see `transactions.ts:57`, `invites.ts:60`) |
| 401 | `unauthenticated` | no session cookie |
| 402 | `upgrade_required` | `effectiveTier(userId).tier !== "pro"` |
| 403 | `insufficient_role` | POST: caller is `viewer` (needs `editor`); thrown by `requireWorkspaceContext` |
| 404 | `no_membership` | session valid but user not a member of `:id` |
| 500 | `chat_provider_error` | Gemini SDK throws (network, malformed response, etc.) — full error logged server-side, generic message to client |

Out of scope for 1E: per-user rate limiting (`429`). Master spec §11.3 calls for it; deferred to a future safety plan.

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

Convert zod schemas to JSON Schema for Gemini's `functionDeclarations`. Two important details:

1. **Use `parametersJsonSchema` (not `parameters`).** `FunctionDeclaration.parameters: Schema` is Gemini's typed OpenAPI 3.03 subset; `parametersJsonSchema: unknown` is the JSON-Schema-format alternative. They are mutually exclusive. `zod-to-json-schema` emits JSON Schema, so the second field is the correct target.
2. **Omit the field entirely for zero-arg tools.** Gemini rejects `parameters: { type: "object", properties: {} }` ("properties: should be non-empty for OBJECT type"). For tools whose `args` is `z.object({})`, drop the field.

```ts
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { FunctionDeclaration } from "@google/genai";
import type { ToolDef } from "./tools/types.js";

export function toGeminiFunctionDeclarations(tools: ToolDef[]): FunctionDeclaration[] {
  return tools.map((t) => {
    const decl: FunctionDeclaration = { name: t.name, description: t.description };
    if (hasAnyKeys(t.args)) {
      decl.parametersJsonSchema = zodToJsonSchema(t.args, { $refStrategy: "none" });
    }
    return decl;
  });
}

function hasAnyKeys(schema: z.ZodType): boolean {
  if (!(schema instanceof z.ZodObject)) return true;
  return Object.keys(schema.shape).length > 0;
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

  // Gemini may send no args object for zero-arg tools — coerce to {} so
  // z.object({}).safeParse doesn't fail on undefined.
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, error: `invalid_args: ${parsed.error.message}` };

  try {
    const result = await tool.run(ctx, parsed.data);
    return { ok: true, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Log full error server-side (sanitized) for debugging; truncate the LLM-facing message.
    console.error("chat tool failed", { toolName, err: e });
    return { ok: false, error: msg.slice(0, 500) };
  }
}
```

The dispatcher never throws. Errors become `{ ok: false, error }` and are wrapped as `{ error }` in the Gemini `functionResponse.response` (see §5.4).

### 4.5 Tool reference

Names + zod arg schemas. **Per-field `.describe()` is mandatory** — `zod-to-json-schema` propagates these into the JSON Schema's `description` field, and Gemini reads them when picking which tool/arg to call.

```ts
// listTransactions
args: z.object({
  period: z.enum(["today", "this_week", "this_month", "last_month"])
    .describe("Time window for the listing. Omit for all-time.")
    .optional(),
  limit: z.number().int().positive().max(50)
    .describe("Max transactions to return. Default 20, hard cap 50.")
    .optional(),
});

// getSpendingSummary
args: z.object({
  period: z.enum(["this_week", "this_month", "last_month"])
    .describe("Period to summarize."),
  group_by: z.enum(["category", "merchant", "day"])
    .describe("Bucket dimension. Defaults to 'category'.")
    .optional(),
});

// listCategories — zero args; adapter omits the parameters field entirely (see §4.3)
args: z.object({});

// categorizeTransaction
args: z.object({
  tx_id: z.string().min(1)
    .describe("Transaction id (cuid) — must belong to the current workspace."),
  category: z.string().min(1)
    .describe("Category name (case-insensitive match within the workspace's categories)."),
});
```

**Tool implementation contracts:**

- All tools enforce workspace ownership via `ctx.workspaceId` on every query. Cross-workspace `tx_id` → tool throws → dispatcher returns `{ error }` → LLM explains.
- `categorizeTransaction` must execute the same 6-step manual-categorize algorithm Plan 1B-categorize implemented inline at `apps/api/src/routes/transactions.ts:126-246`:
  1. Load tx (verify workspace ownership).
  2. Resolve category — **filter `archivedAt: null`** + case-insensitive name match within workspace.
  3. Inside one `prisma.$transaction`:
     - Update target tx: `categoryId`, `categorizationSource: "manual"`, backfill `merchantNormalized` if null.
     - Upsert `merchant_mappings` row: `source: "manual"`, `confidence: 1.00`.
     - Normalize null-`merchantNormalized` siblings (load candidates whose raw merchant looks similar, normalize lazily).
     - Back-fill siblings: `updateMany` with `merchantNormalized` match, `id: { not: tx.id }`, **NULL-safe predicate** `OR: [{ categorizationSource: null }, { categorizationSource: { not: "manual" } }]` so prior manual decisions are NOT clobbered. Set `categoryId` + `categorizationSource: "mapping"`.

  **Refactor decision:** Plan 1E **extracts** this inline route logic into a shared service `apps/api/src/categorize/manual-categorize.ts` exporting `applyManualCategorize({ workspaceId, txId, categoryName })`. Both the existing `POST /transactions/:txId/categorize` route AND the new chat tool call it. Rationale:
  - Single source of truth — the 100-line algorithm cannot drift between the two call sites.
  - Existing route tests verify the algorithm; chat tool tests can be lean (just invocation + error paths).
  - Cost: one refactor commit before the chat-tool commit; the route's HTTP-shape tests stay green because the service returns the same shape the route currently constructs inline.

  Scope inside 1E: the extraction is part of the chat-tool task, not a separate plan. The plan splits this into two ordered commits: `refactor(categorize): extract applyManualCategorize service` → `feat(chat): categorizeTransaction tool calls applyManualCategorize`.

  **Naming mapping (LLM-facing snake_case ↔ service camelCase):** the tool keeps snake_case arg names because Gemini's tool-selection prompts that style; the service uses TypeScript camelCase. The tool's `run()` body does the mapping explicitly:
  ```ts
  await applyManualCategorize({
    workspaceId: ctx.workspaceId,
    txId: args.tx_id,
    categoryName: args.category,
  });
  ```
  Service return shape: `{ tx: { id, categoryId, categorizationSource, ... }, backfilledCount }` — the existing route at `transactions.ts:227-241` already wraps that shape into an HTTP response, so the route's post-extraction body becomes a thin caller that re-uses the same wrapping.

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

Gemini requires every `functionResponse` part to be **preceded by** a `model`-role `functionCall` part with the same name in the same `contents` array. Since the assistant's "I'm calling tool X" turn is not stored as its own row, the tool row's `blocks[0]` carries both `args` (to reconstruct the `functionCall`) and `result` (to reconstruct the `functionResponse`). Each tool row therefore expands into **two** Gemini parts on rehydration.

`FunctionResponse.response` is typed `Record<string, unknown>` — pass through as `{ output: result }` for success, `{ error: msg }` for failure. The Gemini docs explicitly use these keys.

```ts
type ToolBlock = { type: "tool"; toolName: string; args: unknown; result: unknown };

function toGeminiHistory(messages: ChatMessage[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const blocks = m.blocks as Block[];
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: (blocks[0] as TextBlock).markdown }] });
      continue;
    }
    if (m.role === "assistant") {
      out.push({ role: "model", parts: [{ text: (blocks[0] as TextBlock).markdown }] });
      continue;
    }
    // role === "tool" — emit BOTH the model's functionCall and the user's functionResponse.
    const t = blocks[0] as ToolBlock;
    const isError = t.result && typeof t.result === "object" && "error" in (t.result as object);
    const response = isError ? (t.result as { error: string }) : { output: t.result };
    out.push({ role: "model", parts: [{ functionCall: { name: t.toolName, args: t.args } }] });
    out.push({ role: "user", parts: [{ functionResponse: { name: t.toolName, response } }] });
  }
  // Gemini requires the first content to have role "user". The HISTORY_LIMIT
  // window can start with a `role:"tool"` row whose preceding user message
  // has rolled out — that produces a leading `model(functionCall)` part which
  // Gemini rejects. Drop leading non-user parts until we find a user role.
  while (out.length > 0 && out[0].role !== "user") {
    out.shift();
  }
  return out;
}
```

The caller (`processChatTurn`) must guard against an empty result before issuing the Gemini call. In the 1E flow the just-inserted user message is always last in `historyChrono` so `out` is non-empty in practice, but a future caller (e.g. morning-ritual `daily` thread) might invoke without a fresh user row. Throw a sentinel error so it surfaces as `chat_provider_error` with a useful log rather than an opaque Gemini 400.

### 5.4 Main loop — `apps/api/src/chat/turn.ts`

Three subtleties:

1. **Loop bound counts tool dispatches, not LLM calls.** After `MAX_TOOL_CALLS` dispatches, one final LLM call asks the model to summarize. The bug-prone "off-by-one" in the original draft (`<=` with apology inside) wasted an extra LLM call.
2. **Gemini 2.5 may emit multiple `functionCall` parts in one response (parallel tool use).** The SDK exposes `resp.functionCalls: FunctionCall[]`. We must dispatch all of them, persist each as its own `role:"tool"` row, and append one `model(functionCall)` part + one `user(functionResponse)` part per dispatch in the same iteration. Each parallel call counts toward `MAX_TOOL_CALLS`.
3. **`FunctionResponse.response` must be a `Record<string, unknown>`.** Wrap success as `{ output: result }`, error as `{ error: msg }`. Per Gemini docs.

```ts
export async function processChatTurn(
  env: Env,
  thread: { id: string; workspaceId: string },
  userId: string,
): Promise<{ assistantText: string; toolCalls: ToolCallRecord[] }> {
  const HISTORY_LIMIT  = env.CHAT_HISTORY_LIMIT           ?? 20;
  const MAX_TOOL_CALLS = env.CHAT_MAX_TOOL_CALLS_PER_TURN ?? 10;
  const MODEL          = env.CHAT_MODEL                   ?? "gemini-2.5-flash-lite";

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
  // Guard: toGeminiHistory may have trimmed every leading non-user part
  // (see §5.3). Surfacing as chat_provider_error with a clear log beats
  // an opaque Gemini 400 about empty contents.
  if (contents.length === 0) {
    throw new Error("chat_history_empty");
  }
  const toolCalls: ToolCallRecord[] = [];
  let dispatched = 0;

  while (true) {
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { systemInstruction: sysInstruction, tools },
    });

    const fcs = resp.functionCalls ?? [];
    if (fcs.length === 0) {
      // Final text turn.
      return { assistantText: resp.text ?? "", toolCalls };
    }

    if (dispatched + fcs.length > MAX_TOOL_CALLS) {
      console.warn("chat: max tool calls exceeded", {
        threadId: thread.id,
        dispatched,
        requested: fcs.length,
      });
      return {
        assistantText: "I couldn't complete that — try a simpler request.",
        toolCalls,
      };
    }

    // Dispatch all parallel calls in this round; append one (model, user) part-pair each.
    // SDK types `FunctionCall.name` and `.args` as optional. A call without
    // `name` is unusable (no tool to dispatch); skip with a logged warning.
    const newContents: GeminiContent[] = [...contents];
    let dispatchedThisRound = 0;
    for (const fc of fcs) {
      if (!fc.name) {
        console.warn("chat: function call missing name", { threadId: thread.id });
        continue;
      }
      const fcName = fc.name;
      const fcArgs = fc.args ?? {};

      const dispatch = await dispatchTool(ctx, fcName, fcArgs);
      const responseObj = dispatch.ok
        ? { output: dispatch.result }
        : { error: dispatch.error };

      toolCalls.push({ toolName: fcName, args: fcArgs, result: responseObj });

      await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          role: "tool",
          blocks: [{ type: "tool", toolName: fcName, args: fcArgs, result: responseObj }],
        },
      });

      newContents.push(
        { role: "model", parts: [{ functionCall: { name: fcName, args: fcArgs } }] },
        { role: "user",  parts: [{ functionResponse: { name: fcName, response: responseObj } }] },
      );
      dispatched++;
      dispatchedThisRound++;
    }

    // Safety: Gemini returned function calls but every one was unusable
    // (e.g. all missing `name`). Re-issuing the same request with unchanged
    // contents would loop forever. Bail with an apology.
    if (dispatchedThisRound === 0) {
      console.warn("chat: function-call round with no dispatchable calls", {
        threadId: thread.id, requested: fcs.length,
      });
      return {
        assistantText: "I couldn't complete that — try a simpler request.",
        toolCalls,
      };
    }

    contents = newContents;
  }
}
```

**Helper accessors are direct SDK fields** — no separate `extractFunctionCall`/`extractText` functions:
- `resp.functionCalls?: FunctionCall[]` — undefined if no calls; else array (length 1 for serial, >1 for parallel)
- `resp.text?: string` — convenience getter on the response object

---

## 6. Concurrency, Errors, Privacy

### 6.1 Concurrency

- **Same workspace, two simultaneous user messages:** both insert user messages; each turn loads its own history. The second turn sees the first's user message. Acceptable at dogfood scale; no advisory lock.
- **Tool execution:** Prisma's connection pool handles concurrency. `categorizeTransaction` calls `prisma.transaction.update` (atomic single-row write).

### 6.2 Error handling

| Failure | Response |
|---|---|
| Gemini API throws (network, 5xx) | 500 `chat_provider_error`. User message persisted; assistant message NOT persisted. Tool side-effects from earlier in the turn ARE persisted (see below). Log sanitized error. |
| Gemini returns neither text nor functionCall | Treat as empty turn — `assistantText: ""`. Route persists assistant message with empty `markdown: ""` (UI renders as blank bubble — acceptable degraded state, expected to be rare). Log warning. |
| Tool throws | Caught in `dispatcher.ts` → `{ ok: false, error }` → LLM sees `{ error }` in functionResponse |
| `MAX_TOOL_CALLS` exceeded | Apology assistant message. Log warning with thread id. |
| Tier check fails | 402 `upgrade_required` before user message is persisted |

**Mid-turn failure with tool side-effects:** If `categorizeTransaction` runs successfully and then the next Gemini call throws, the DB write **is preserved** (no transaction wrap — see why below) and the corresponding `role: "tool"` row is in the audit trail. The user sees a 500 with no assistant message. This is acceptable because:

- A naive client retry posts the same user message; the next turn's history rehydration includes the prior `role: "tool"` row, so Gemini sees the categorization already happened and won't double-write.
- Wrapping the entire turn in `prisma.$transaction` is rejected — it would hold a DB transaction open across multi-second LLM calls, blocking other writes.
- User-visible reconciliation ("your last message couldn't complete, but X was already done") is deferred to a future plan.

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
- **LLM returns 2 functionCalls in one response (parallel tool use)** → both dispatched → 2 `role:"tool"` rows persisted → both `dispatched` count toward MAX_TOOL_CALLS → next LLM turn returns text
- LLM returns 11 functionCalls across iterations → loop returns apology, log warning fires
- Gemini SDK throws → exception propagates (route returns 500)
- Tool dispatcher returns error → LLM sees `{ error }` → mock LLM returns explanatory text
- **Multi-turn rehydration:** turn 1 includes a tool call. Turn 2 starts; verify `toGeminiHistory` produces both `model(functionCall)` and `user(functionResponse)` parts from the persisted `role:"tool"` row (catches I6 from review).
- **`listCategories()` zero-arg call:** Gemini sends `functionCalls[0].args = undefined` → dispatcher coerces to `{}` → tool runs successfully (catches C4 dispatcher path).

### 7.4 Integration — Route

`chat.routes.test.ts` with `vi.mock("@google/genai", ...)`:

- Free user (expired trial) → POST `/chat/message` → 402 `upgrade_required`, no thread/message rows created
- Pro user → POST `/chat/message` → 200, thread upserted (`type: "adhoc"`), user+assistant messages persisted, response shape correct
- Second message → reuses existing thread (composite `@@unique([workspaceId, type])`)
- Pro user → GET `/chat/thread` → returns thread + messages oldest-first
- Pro user → POST without `X-Workspace-Id` header → 400 `missing_workspace_header`
- Pro user → POST with `:id` ≠ ctx workspace → 400 `workspace_mismatch`
- Gemini mock throws → 500 `chat_provider_error`, user message IS persisted (inserted before `processChatTurn` per §3.1 step 6 → §6.2), no assistant message
- Pro user with `viewer` role → POST `/chat/message` → 403 `insufficient_role`
- **`categorizeTransaction` chat-tool variant** → tool succeeds → DB shows: target tx `categoryId` set + `categorizationSource: "manual"`, `merchant_mappings` upserted with `source: "manual"`, sibling tx with same `merchantNormalized` back-filled with `categorizationSource: "mapping"` (matches Plan 1B-categorize behavior; catches I8 from review).

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
- [ ] All existing API tests stay green; new tests pass.
- [ ] E2E (skip-guarded on `GEMINI_API_KEY`): real Gemini conversation completes with at least one tool call.
