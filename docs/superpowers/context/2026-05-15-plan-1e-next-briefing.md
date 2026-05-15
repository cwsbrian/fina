# Plan 1E-next Brainstorming Briefing

**Date:** 2026-05-15
**Purpose:** Self-contained briefing for fresh-session brainstorming agents.
**Task:** Design Plan 1E-next — additional chat tools for the Fina personal-finance app.

> This document is your ONLY context. Do not assume prior conversation history.
> Read it fully before brainstorming.

---

## 1. What is Fina?

Fina is a personal-finance app for **Canadian users**. Users connect their bank accounts via **Plaid** (Open Banking), transactions are synced and auto-categorized, and users can explore their finances via a **chat agent** powered by Gemini 2.5 Flash Lite.

**Tier structure:**
- **Free** — no Plaid connections (no bank sync)
- **Lite** — up to 2 Plaid connections
- **Pro** — up to 5 Plaid connections; full chat access
- **Trial** — new accounts get 30-day Pro trial; after expiry, items are removed (Plaid charges ~$0.25/item/month)

**Currency:** CAD by default.

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| API | Fastify (TypeScript) |
| ORM | Prisma + PostgreSQL |
| Validation | Zod |
| Tests | Vitest (unit + integration, real DB), Playwright (E2E) |
| LLM | `@google/genai` SDK — Gemini 2.5 Flash Lite |
| Schema-to-JSON | `zod-to-json-schema` |
| Bank sync | Plaid (transactions, webhooks) |
| Auth | Better Auth (sessions, cookies) |

**Workspace:** pnpm monorepo. API lives at `apps/api/`. Tests at `apps/api/tests/`. E2E at `e2e/`.

---

## 3. Key database models

```
User            — id (no @default, Better Auth manages), email, trialEndsAt, trialConsumed
Workspace       — id, name
Membership      — userId, workspaceId, role (owner | editor | viewer)
PlaidItem       — workspaceId, accessTokenCiphertext, status (active | disconnected | error)
BankAccount     — workspaceId, plaidItemId?, name, type, subtype, currency, status,
                  balanceCurrent?, balanceAvailable?, balanceLimit?, archivedAt?
Transaction     — workspaceId, accountId, amount (Decimal), currency, merchantRaw,
                  merchantNormalized?, categoryId?, occurredAt, pending, source,
                  note?, removedAt?, categorizationSource?
Category        — workspaceId, name, parentId?, icon?, color?, archivedAt?
MerchantMapping — workspaceId, merchantNormalized, categoryId, confidence, source (mapping|ai|manual)
ChatThread      — workspaceId, type (adhoc|daily), @@unique([workspaceId, type])
ChatMessage     — threadId, role (user|assistant|tool), blocks (Json), createdAt
```

**CategorizationSource enum:** `mapping | ai | manual`

**Transaction.amount** is a `Decimal` — call `.toString()` when returning as JSON.

**Transaction.removedAt** — soft-delete. Active transactions have `removedAt: null`.

---

## 4. Current chat architecture

### 4.1 How a turn works

```
POST /workspaces/:id/chat/message { text }
  │
  ├─ requireWorkspaceContext (requiredRole: "editor")
  ├─ effectiveTier check (Pro only → 402)
  ├─ upsert ChatThread (type: "adhoc")
  ├─ insert ChatMessage (role: "user", blocks: [{type:"text", markdown:text}])
  │
  └─ processChatTurn(env, thread, userId)
       │
       ├─ load last N messages (CHAT_HISTORY_LIMIT, default 20)
       ├─ buildFinancialContext(workspaceId) → system prompt suffix
       ├─ toGeminiHistory(messages) → Gemini content array
       ├─ while (true):
       │    resp = Gemini.generateContent(...)
       │    if no functionCalls → return assistantText
       │    dispatch each fc via dispatchTool → persist tool row
       │    accumulate newContents (model+user parts per fc)
       │    if dispatched > MAX_TOOL_CALLS → apology
       │    if dispatchedThisRound === 0 → apology (infinite-loop guard)
       │
       └─ insert ChatMessage (role: "assistant", blocks: [{type:"text", markdown}])
```

### 4.2 Tool interface

Every tool implements this TypeScript type (`apps/api/src/chat/tools/types.ts`):

```ts
export type ToolContext = {
  env: Env;
  workspaceId: string;   // enforced on every DB query — no cross-workspace leaks
  userId: string;
};

export type ToolDef<TArgs = unknown, TResult = unknown> = {
  name: string;           // camelCase, used as Gemini function name
  description: string;   // shown to LLM — be precise
  args: z.ZodType<TArgs>; // every field MUST have .describe()
  run: (ctx: ToolContext, args: TArgs) => Promise<TResult>;
};
```

**Critical rules for tool design:**
- Every `z.object` field needs `.describe("...")` — `zod-to-json-schema` propagates these to Gemini's function-call hints
- Zero-arg tools use `args: z.object({})` — the adapter omits `parametersJsonSchema` for these
- LLM-facing arg names: snake_case (e.g. `tx_id`, `category_name`); internal service calls: camelCase
- Tool throws → dispatcher catches → LLM sees `{ error: "..." }` in functionResponse → LLM explains gracefully
- Never throw HTTP errors from tools; throw domain errors (`new Error("not_found")`)

### 4.3 Tool file layout

```
apps/api/src/chat/tools/
  types.ts                    # ToolDef, ToolContext (do not modify)
  index.ts                    # REGISTRY: ToolDef[] (add new tools here)
  list-transactions.ts        # ✅ exists
  get-spending-summary.ts     # ✅ exists
  list-categories.ts          # ✅ exists
  categorize-transaction.ts   # ✅ exists
  <new-tool>.ts               # you will design these
```

### 4.4 Dispatcher (do not modify)

```ts
// apps/api/src/chat/dispatcher.ts
export async function dispatchTool(
  ctx: ToolContext,
  toolName: string,
  rawArgs: unknown,
  registry: ToolDef[],
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }>
```

The dispatcher: looks up tool by name → `zod.safeParse(rawArgs ?? {})` → calls `tool.run()` → catches all throws → returns `{ ok, result | error }`. Never rethrows.

### 4.5 Gemini adapter (do not modify)

```ts
// apps/api/src/chat/gemini-adapter.ts
export function toGeminiFunctionDeclarations(tools: ToolDef[]): FunctionDeclaration[]
```

Uses `zod-to-json-schema` with `$refStrategy: "none"`. Omits `parametersJsonSchema` for zero-arg (`z.object({})`) tools.

### 4.6 Financial context (current)

```ts
// apps/api/src/chat/context.ts
export async function buildFinancialContext(workspaceId: string): Promise<string>
// Returns:
// ## Current state
// - Total transactions: N
// - Latest transaction date: YYYY-MM-DD
// - Categories defined: N
```

Intentionally minimal (no PII). Future tools may require expanding this.

---

## 5. The 4 existing tools

| Name | Args | What it does |
|---|---|---|
| `listTransactions` | `period?`, `limit?` | Fetches recent txs (newest first, max 50). Returns id, amount, merchantRaw, merchantNormalized, categoryId, occurredAt. |
| `getSpendingSummary` | `period`, `group_by?` | Totals spending in a period, bucketed by category/merchant/day. Returns groups with key, total, count. |
| `listCategories` | (none) | Lists active (non-archived) categories for the workspace, sorted by name. Returns id, name. |
| `categorizeTransaction` | `tx_id`, `category` | Assigns category to tx, upserts merchant_mapping, back-fills siblings. Delegates to `applyManualCategorize`. |

---

## 6. Existing service: `applyManualCategorize`

```ts
// apps/api/src/categorize/manual-categorize.ts
export async function applyManualCategorize(input: {
  workspaceId: string;
  txId: string;
  categoryName: string;
}): Promise<{
  tx: { id, amount, currency, merchantRaw, merchantNormalized, categoryId, categorizationSource, occurredAt };
  backfilledCount: number;
}>
```

Throws `ManualCategorizeError` with `code: "tx_not_found" | "category_not_found"`.

---

## 7. What's out of scope for this brainstorm

Do NOT design these — they belong to separate plans:
- **confirm_card / dangerous writes** (addTransaction, deleteTransaction, addRecurring) — require a multi-step confirmation UI pattern not yet designed
- **Rich block types** (categorize_card, confirm_card, presentCards) — require mobile UI changes
- **SSE streaming** — separate infrastructure plan
- **Morning ritual** — separate daily-thread plan
- **Lite tier chat** — separate tier plan
- **PII redaction layer** — separate security plan

---

## 8. Your task

**Design Plan 1E-next: the next set of chat tools.**

These tools should be:
1. **Read-only or safe writes** — no dangerous destructive operations
2. **Immediately useful** for a Pro user exploring their finances
3. **Implementable** without new DB tables or schema changes (use existing models)
4. **Distinct** — don't overlap with the 4 existing tools

Think about what a user would naturally ask their finance assistant that can't be answered today.

### Brainstorming process

1. **Identify gaps** — what common financial questions can't the current 4 tools answer?
2. **Propose tools** — for each, define: name, description, zod args (with `.describe()`), return shape, implementation notes
3. **Prioritize** — which 5-8 tools give the most value? rank by impact vs complexity
4. **Self-review loop** — after drafting, review your own spec using the same Critical/Important/Minor classification below. Fix all Critical and Important issues. Repeat until you can honestly report **0 Critical + 0 Important**. Only then is the spec considered done.

### Self-review classification

| Severity | Definition | Required action |
|---|---|---|
| **Critical** | Would cause runtime failure, data corruption, type error, or implementation impossibility | Must fix before done |
| **Important** | Design defect, contradiction between sections, missing edge case, unclear contract | Must fix before done |
| **Minor** | Cosmetic, wording, non-blocking | Fix if quick, otherwise skip |

**Exit condition:** You must reach 0 Critical + 0 Important in a review pass before your spec is considered production-ready. If you find issues, fix them and run another review pass. Document each round: what you found, what you fixed.

This is the same bar as the established production workflow (Codex external review loop). The difference is you are reviewing your own work.

### Output format

Write a design spec to:
```
docs/superpowers/specs/2026-05-15-plan-1e-next-<your-variant>-design.md
```

Where `<your-variant>` is either `opus`, `codex`, or `claude-codex`.

The spec should include:
- **Proposed tools** (5-8) with full arg/return schemas and implementation notes
- **Rationale** — why these tools, in this order
- **Excluded scope** — what you deliberately left out and why
- **Self-review log** — document each review round: issues found (classified as Critical/Important/Minor), fixes applied, and the final "0 Critical + 0 Important" confirmation

---

## 9. Constraints and patterns to follow

- **YAGNI** — only design what's needed for real user queries, not hypothetical future features
- **Workspace isolation** — every DB query must filter by `ctx.workspaceId`
- **No new Prisma models** — use existing tables only
- **Zod `.describe()` on every arg** — mandatory for Gemini tool-call quality
- **Error transparency** — tools should throw descriptive errors; dispatcher catches them
- **Test-friendly** — tools must be testable with `tool.run(ctx, args)` directly (no Fastify dependency)
- **Amount serialization** — `Decimal.toString()` for all monetary values in return shapes
- **Date format** — ISO 8601 strings for dates/times in return shapes

---

## 10. Reference: file structure

```
apps/api/
  prisma/schema.prisma          # full DB schema
  src/
    chat/
      tools/
        types.ts                # ToolDef, ToolContext
        index.ts                # REGISTRY (modify: add new tools)
        list-transactions.ts    # example tool
        get-spending-summary.ts # example tool
      dispatcher.ts             # do not modify
      gemini-adapter.ts         # do not modify
      context.ts                # may want to extend for new tools
      turn.ts                   # do not modify
    categorize/
      manual-categorize.ts      # reusable service for categorize tools
    routes/
      chat.ts                   # do not modify
```

---

## 11. Evaluation criteria (for post-design debate)

Your design will be evaluated on:
1. **Coverage** — what % of common financial questions can now be answered?
2. **Arg precision** — are zod schemas tight enough to prevent misuse?
3. **Describe quality** — would the LLM know how to use each arg correctly?
4. **Edge case handling** — what happens with empty data, invalid inputs, cross-workspace txIds?
5. **Implementation clarity** — could a developer implement each tool from the spec alone?
6. **Self-review honesty** — did you catch real issues or just cosmetic ones?
