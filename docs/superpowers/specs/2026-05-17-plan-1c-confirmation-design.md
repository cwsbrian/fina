# Plan 1C-confirmation — action_intents + presentConfirmCard

**Date:** 2026-05-17
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes + Confirmation, per master design §15.1C / §11.1)

---

## 1. Goal

Add a 2-phase commit safety net for LLM-driven mutations. New
`ActionIntent` entity + intent issue/consume API + `presentConfirmCard`
chat tool + `confirm_card` block type. Existing write tools (the 6 from
prior 1C plans) keep direct-execution behavior; the LLM decides per
system prompt guidance whether to call a write tool directly or wrap it
in a confirm card.

The architecture matches master design §11.1: raw `ToolCall` payloads
never appear on the client → server path. The block sent to the client
carries only a server-issued intent ID; the user tap POSTs that ID back
to consume, and the server looks up and executes the original action.
Prevents confused-deputy / replay attacks if the client or any
intermediate layer is compromised.

---

## 2. Background

Master design §5 lists write tools as needing confirmation: "tool-calling
agent — 채팅 안에서 실제 앱 state 변경 가능... 안전장치". §11.1 spells out
the confirmation flow as the safety model:

```
1. LLM emits presentConfirmCard({ question, accept_action: ToolCall })
2. Server stores action_intents row: { id, payload: ToolCall, expires_at }
3. Block to client: { type: "confirm_card", accept_intent: "int_abc..." }
4. User taps ✓ → POST /intents/int_abc/consume
5. Server: lookup → expire/consume checks → execute payload → mark consumed
```

Today the 6 existing write tools execute immediately when the LLM calls
them. The system prompt instructs the LLM to "briefly confirm with the
user before invoking unless the request is unambiguous", but there is no
mechanism: the LLM just emits the tool call and the server runs it.

This plan adds the mechanism. It does NOT force any existing tool through
the new flow — the LLM continues to choose direct vs. confirm-card per
the same heuristic.

---

## 3. Decisions resolved during brainstorm

| Topic | Decision |
|---|---|
| v1 scope | Pure infrastructure: schema + service + route + `presentConfirmCard` tool + chat turn integration |
| TTL | 1 hour fixed (master design) |
| Reject endpoint | None — client drops card on `✗`; server lets intent expire |
| Confirmable tools | Whitelist: the 6 write tools (`createCategory`, `addTransactionNote`, `setBudget`, `mapMerchantToCategory`, `addRecurring`, `removeRecurring`). `presentConfirmCard` explicitly excluded (no recursion). Read tools excluded (no value). |
| Args pre-validation | Validate accept_action.args against target tool's Zod schema at `presentConfirmCard` time. Re-validate at consume time as defense. |
| Consume race | Atomic `UPDATE … SET consumedAt = NOW() WHERE id = ? AND consumedAt IS NULL` → if zero rows updated, return `intent_gone`. |
| Consume response | `200 { result: <tool output> }` so chat layer / future UI can show post-action feedback. |
| Tool errors during consume | Propagate as 500 by default (e.g. `category_not_found`). Exception: `insufficient_role` is translated to 403 because an editor can issue a confirm card for an owner-only target (today only `createCategory` has this gate); 403 is the meaningful surface, not 500. |
| Role gate (consume + presentConfirmCard) | editor+ inherited from chat route. |
| Tier gate | Pro (consume route + chat route are both Pro-gated). |
| Audit log entry on consume | Out of scope — separate 1C-audit plan. |
| Cron cleanup of old intents | Out of scope. |

---

## 4. Data model

```prisma
model ActionIntent {
  id          String    @id @default(cuid())
  workspaceId String
  userId      String
  messageId   String?   // chat_messages link (nullable for non-chat uses)
  kind        String    // "tool_call" — only kind v1; room for future kinds
  payload     Json      // { tool: "createCategory", args: { name: "Coffee" } }
  expiresAt   DateTime
  consumedAt  DateTime?
  createdAt   DateTime  @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user      User      @relation(fields: [userId],      references: [id], onDelete: Cascade)

  @@index([workspaceId, userId, expiresAt])
  @@map("action_intents")
}
```

Inverse relations:
- `Workspace { actionIntents ActionIntent[] }`
- `User      { actionIntents ActionIntent[] }`

Notes:
- Both FKs cascade on owner delete (cleaning up a workspace or user
  removes their intents).
- `messageId` is `String?` (no FK constraint yet) — future plans may
  link to `chat_messages` for traceability; v1 leaves it nullable +
  unenforced.
- Index `(workspaceId, userId, expiresAt)` supports "active intents
  for this user" lookups in future cleanup or list endpoints.

---

## 5. Service module

`apps/api/src/intents/service.ts`:

```typescript
import type { Role } from "@fina/shared";
import type { Env } from "../env.js";

export const CONFIRMABLE_TOOLS = [
  "createCategory",
  "addTransactionNote",
  "setBudget",
  "mapMerchantToCategory",
  "addRecurring",
  "removeRecurring",
] as const;
export type ConfirmableTool = (typeof CONFIRMABLE_TOOLS)[number];

const INTENT_TTL_MS = 60 * 60 * 1000;  // 1 hour

export type IntentPayload = { tool: string; args: Record<string, unknown> };

export type CreateIntentInput = {
  tool: string;
  args: Record<string, unknown>;
  messageId?: string;
};

export type CreateIntentOutput = { intent: { id: string; expiresAt: string } };

export async function createIntentService(
  ctx: { workspaceId: string; userId: string },
  input: CreateIntentInput,
): Promise<CreateIntentOutput>;

export async function consumeIntentService(
  ctx: { workspaceId: string; userId: string; role: Role; env: Env },
  intentId: string,
): Promise<{ result: unknown }>;
```

**`createIntentService` steps:**
1. Whitelist via type guard (avoids TS error: `as const` tuple's `.includes()` rejects a plain `string` argument under strict settings):
   ```typescript
   function isConfirmable(t: string): t is ConfirmableTool {
     return (CONFIRMABLE_TOOLS as readonly string[]).includes(t);
   }
   if (!isConfirmable(input.tool)) throw new Error("invalid_tool");
   ```
2. Resolve target tool: `const tool = REGISTRY.find(t => t.name === input.tool); if (!tool) throw invalid_tool` (defense — whitelist should already guarantee this).
3. Pre-validate args: `tool.args.safeParse(input.args)`. If `!success`, throw `invalid_payload_args`.
4. Compute `expiresAt = new Date(Date.now() + INTENT_TTL_MS)`.
5. Build the create data without setting `messageId` when undefined (exactOptionalPropertyTypes). Use the same `Parameters<typeof prisma.actionIntent.create>[0]["data"]` conditional-assignment pattern from earlier plans:
   ```typescript
   const data: Prisma.ActionIntentCreateInput = {
     workspace: { connect: { id: ctx.workspaceId } },
     user: { connect: { id: ctx.userId } },
     kind: "tool_call",
     payload: { tool: input.tool, args: input.args } as Prisma.InputJsonValue,
     expiresAt,
   };
   if (input.messageId !== undefined) data.message = { connect: { id: input.messageId } };
   // Note: messageId field is plain String? (no FK); use direct field instead of `connect`:
   //   if (input.messageId !== undefined) data.messageId = input.messageId;
   //   (see schema — messageId is a plain column without `@relation` declaration)
   ```
   Adjust based on the final schema field shape (the schema in §4 declares `messageId` as a plain `String?` without a `@relation`, so the second form applies).
6. `prisma.actionIntent.create({ data })`.
7. Return `{ intent: { id, expiresAt: expiresAt.toISOString() } }`.

**`consumeIntentService` steps:**
1. `findUnique({ where: { id: intentId } })`. Null → throw `intent_not_found`.
2. Owner check: `row.workspaceId === ctx.workspaceId && row.userId === ctx.userId`. Mismatch → throw `intent_owner_mismatch`.
3. Pre-flight gone check: `row.consumedAt !== null || row.expiresAt <= new Date()` → throw `intent_gone`. (Fast-fail before the atomic update — saves one DB roundtrip in the common error case.)
4. Atomic mark: `updateMany({ where: { id: intentId, consumedAt: null, expiresAt: { gt: new Date() } }, data: { consumedAt: new Date() } })`. If `count === 0` → throw `intent_gone` (race lost).
5. Re-parse payload: `const payload = row.payload as IntentPayload`. Validate `tool ∈ CONFIRMABLE_TOOLS` (defense). Look up `tool` in REGISTRY (defense). Re-validate args via `tool.args.safeParse(payload.args)`. Any failure → throw a coded error (`invalid_payload_args` — would only fire if DB row was tampered with directly; bubble up as 500 from route).
6. Dispatch: `const result = await tool.run({ env: ctx.env, workspaceId: ctx.workspaceId, userId: ctx.userId, role: ctx.role }, parsedArgs.data); return { result };`. Errors thrown by the dispatched tool (e.g. `category_not_found`) propagate to the caller — the route surfaces them as 500.

---

## 6. Chat tool: `presentConfirmCard`

`apps/api/src/chat/tools/present-confirm-card.ts`:

```typescript
import { z } from "zod";
import { createIntentService } from "../../intents/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  question: z.string().min(1).max(500),
  accept_label: z.string().min(1).max(40).optional(),
  reject_label: z.string().min(1).max(40).optional(),
  accept_action: z.object({
    tool: z.string().min(1),
    args: z.record(z.unknown()),
  }),
});

type Args = z.infer<typeof Args>;

export const presentConfirmCard: ToolDef<
  Args,
  {
    block: {
      type: "confirm_card";
      question: string;
      acceptLabel: string;
      rejectLabel: string;
      acceptIntent: string;
      expiresAt: string;
    };
  }
> = {
  name: "presentConfirmCard",
  description:
    "Display a Yes/No confirmation card for a deferred mutation. accept_action.tool must be one of: createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring. Server validates args against the target tool's schema before issuing the intent. Use this for destructive ops (removeRecurring) and ambiguous or large changes (setBudget delta > 2x). The action runs only when the user taps accept.",
  args: Args,
  async run(ctx, args) {
    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { tool: args.accept_action.tool, args: args.accept_action.args },
    );
    return {
      block: {
        type: "confirm_card",
        question: args.question,
        acceptLabel: args.accept_label ?? "확인",
        rejectLabel: args.reject_label ?? "취소",
        acceptIntent: out.intent.id,
        expiresAt: out.intent.expiresAt,
      },
    };
  },
};
```

**Registry impact:** add to `apps/api/src/chat/tools/index.ts` with `as ToolDef` cast (21 → 22).

---

## 7. Chat turn integration

`apps/api/src/chat/turn.ts` currently returns:
```typescript
{ assistantText: string; toolCalls: ToolCall[] }
```

Extend to:
```typescript
{ assistantText: string; toolCalls: ToolCall[]; presentationBlocks: Block[] }
```

After the tool execution loop completes, walk `toolCalls` and collect
results that contain a `block` field:

```typescript
const presentationBlocks: Block[] = [];
for (const tc of toolCalls) {
  // tc.result is the dispatcher envelope:
  //   { output: <tool output> } on success
  //   { error: string }         on failure
  if (
    tc.result &&
    typeof tc.result === "object" &&
    "output" in tc.result &&
    tc.result.output &&
    typeof tc.result.output === "object" &&
    "block" in tc.result.output
  ) {
    const blk = (tc.result.output as { block: Block }).block;
    presentationBlocks.push(blk);
  }
}
return { assistantText, toolCalls, presentationBlocks };
```

The exact `Block` type union lives in `apps/api/src/chat/blocks.ts` (new
file) so consumers (route + turn) share the definition without `any`:

```typescript
export type TextBlock = { type: "text"; markdown: string };

export type ConfirmCardBlock = {
  type: "confirm_card";
  question: string;
  acceptLabel: string;
  rejectLabel: string;
  acceptIntent: string;
  expiresAt: string;  // ISO
};

export type Block = TextBlock | ConfirmCardBlock;
```

**Route change (`apps/api/src/routes/chat.ts` POST messages handler):**

Today:
```typescript
blocks: [{ type: "text", markdown: turn.assistantText }],
```

After:
```typescript
const blocks: Block[] = [
  { type: "text", markdown: turn.assistantText },
  ...turn.presentationBlocks,
];
```

`chat_messages.blocks` column is already `Json` — no migration. The
shape evolves; older messages without `confirm_card` continue to render
fine in the UI (renderer must handle the discriminant union).

---

## 8. HTTP route: `/intents/:intentId/consume`

`apps/api/src/routes/intents.ts`:

```typescript
import type { FastifyInstance } from "fastify";
import { requireWorkspaceContext, HttpError } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import { consumeIntentService } from "../intents/service.js";

export async function intentsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/intents/:intentId/consume", async (req, reply) => {
    const params = req.params as { id: string; intentId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const result = await consumeIntentService(
        {
          workspaceId: ctx.membership.workspaceId,
          userId: ctx.session.userId,
          role: ctx.membership.role,
          env: app.fina.env,
        },
        params.intentId,
      );
      return reply.code(200).send(result);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const msg = (e as Error).message;
      if (msg === "intent_not_found")
        return reply.code(404).send({ error: "intent_not_found" });
      if (msg === "intent_owner_mismatch")
        return reply.code(403).send({ error: "intent_owner_mismatch" });
      if (msg === "intent_gone") return reply.code(410).send({ error: "intent_gone" });
      // The dispatched tool may throw `insufficient_role` when an editor
      // consumes an intent that wraps an owner-only target (today only
      // createCategory has this gate). Translate to 403 so the client
      // doesn't see a misleading 500.
      if (msg === "insufficient_role")
        return reply.code(403).send({ error: "insufficient_role" });
      throw e;  // other tool-thrown errors propagate as 500 — acceptable v1
    }
  });
}
```

Register in `apps/api/src/server.ts` after `recurringRoutes`.

**Error code summary:**

| Code | HTTP | Cause |
|---|---|---|
| `intent_not_found` | 404 | id doesn't exist |
| `intent_owner_mismatch` | 403 | user/workspace mismatch |
| `intent_gone` | 410 | already consumed or expired |
| `workspace_mismatch` | 400 | path `:id` ≠ `X-Workspace-Id` |
| `upgrade_required` | 402 | non-Pro |
| `insufficient_role` | 403 | dispatched tool's role gate rejected (e.g. editor consuming an owner-only `createCategory` intent) |
| `invalid_tool` / `invalid_payload_args` | 500 | thrown during consume re-validation (DB tamper or service bug) |

---

## 9. System prompt update

Extend the existing write-tool sentence in `apps/api/src/chat/turn.ts`
SYSTEM_PROMPT to mention `presentConfirmCard`. The full replacement
(condensed):

```
For write tools (createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring), briefly confirm with the user before invoking unless the request is unambiguous. When you want a confirm-then-execute flow, call presentConfirmCard with `accept_action` set to the target tool + args — the user sees a Yes/No card and the action runs only when they tap accept. Use this for destructive ops (removeRecurring) and for changes the user might want to reconsider (e.g. tripling a budget, mapping a frequent merchant). Example unambiguous (direct call OK): '카테고리 만들어줘 — Coffee 라는 이름으로'. Example needs presentConfirmCard: 'Netflix 정기지출 삭제' or '식비 예산 500→2000으로 늘려'. ...
```

(The implementation plan will show the full literal replacement so the
implementer matches the existing template-string boundary.)

`listRecurring`, `getBudget`, and other read tools remain unmentioned.

---

## 10. Files

- **Create** `apps/api/prisma/migrations/<ts>_add_action_intents/migration.sql`.
- **Modify** `apps/api/prisma/schema.prisma` — `ActionIntent` model + relations.
- **Create** `apps/api/src/intents/service.ts` — `CONFIRMABLE_TOOLS`, `createIntentService`, `consumeIntentService`.
- **Create** `apps/api/src/chat/blocks.ts` — shared `Block` type union.
- **Create** `apps/api/src/chat/tools/present-confirm-card.ts`.
- **Modify** `apps/api/src/chat/tools/index.ts` — register `presentConfirmCard` with `as ToolDef` cast (21 → 22).
- **Modify** `apps/api/src/chat/turn.ts` — collect `presentationBlocks`; system prompt update.
- **Modify** `apps/api/src/routes/chat.ts` POST messages handler — append `presentationBlocks` to assistant message `blocks`.
- **Create** `apps/api/src/routes/intents.ts` — consume route.
- **Modify** `apps/api/src/server.ts` — register `intentsRoutes`.
- **Modify** `apps/api/tests/chat.tools.registry.test.ts` — bump 21 → 22; add plan-1c-confirmation describe block.
- **Create** `apps/api/tests/intents.service.test.ts` (~10 cases).
- **Create** `apps/api/tests/intents.routes.test.ts` (~6 cases).
- **Create** `apps/api/tests/chat.tools.present-confirm-card.test.ts` (~5 cases).
- **Create** `apps/api/tests/chat.turn.presentation-blocks.test.ts` (~2 cases).

No new dependencies.

---

## 11. Tests

### 11.1 `intents.service.test.ts` (~10 cases)

1. `createIntentService` creates a row with `expiresAt ≈ now + 1h`; `consumedAt = null`.
2. Rejects `tool: "listTransactions"` (not in whitelist) → `invalid_tool`.
3. Rejects `args: { name: "" }` for `createCategory` (Zod fails) → `invalid_payload_args`.
4. `consumeIntentService` happy path: dispatches `createCategory`, returns the tool result, marks `consumedAt`.
5. Returns `intent_not_found` for nonexistent id.
6. Returns `intent_owner_mismatch` for cross-workspace.
7. Returns `intent_owner_mismatch` when same workspace but different user.
8. Returns `intent_gone` for already-consumed intent.
9. Returns `intent_gone` for expired intent (manually set `expiresAt` in past).
10. Race-safe: two `Promise.all` consumes — one returns result, one returns `intent_gone`.

### 11.2 `intents.routes.test.ts` (~7 cases)

1. POST 200 happy → body shape `{ result: { category: { id, name, ... } } }`.
2. POST 404 `intent_not_found` for unknown id.
3. POST 403 `intent_owner_mismatch` (sign in as workspace B, consume an intent owned by workspace A).
4. POST 410 `intent_gone` for already-consumed.
5. POST 402 `upgrade_required` on Free tier.
6. POST 400 `workspace_mismatch` when path `:id` ≠ X-Workspace-Id.
7. POST 403 `insufficient_role` when an editor consumes an intent that wraps `createCategory` (owner-only). Seed via direct service call to create the intent, then sign in as an editor in the same workspace and POST consume.

### 11.3 `chat.tools.present-confirm-card.test.ts` (~5 cases)

1. Zod accepts valid args (question + accept_action with tool + args).
2. Zod rejects when `accept_action` is missing.
3. `run` creates an intent row with `payload.tool` and `payload.args` matching input; returns `block.acceptIntent` = intent id.
4. Returns `block.expiresAt` ≈ now + 1h.
5. `run` propagates `invalid_payload_args` thrown by the service when `accept_action.args` fails the target tool's Zod schema.

### 11.4 `chat.turn.presentation-blocks.test.ts` (~2 cases)

These tests exercise the turn handler's block-collection logic directly
(without going through Gemini). Use the existing pattern from
`chat.turn.test.ts` for stubbing.

1. A tool whose result is `{ block: { type: "confirm_card", ... } }` appears in `presentationBlocks`.
2. A tool whose result is `{ category: { id, name } }` (no `block` key) does NOT pollute `presentationBlocks`.

### 11.5 Registry test (1 bump + new describe block)

- Bump ALL existing `expect(REGISTRY).toHaveLength(21);` assertions to `22`. Current file has **three** such lines (1c-budget block, 1c-merchant-map block, 1c-recurring-persist block — all bumped to 21 by the previous plan). Run `grep -n "toHaveLength" apps/api/tests/chat.tools.registry.test.ts` before editing — expect 3 matches.
- Update all three matching it-name strings to `"registry has 22 tools total"`.
- Append a new `describe("REGISTRY (plan 1c-confirmation)", …)` block asserting `presentConfirmCard` name + canonical description string + length 22.

---

## 12. Acceptance criteria

This plan is complete when:

1. Prisma migration applies cleanly on both `fina` and `fina_test` DBs.
2. `ActionIntent` model + relations regenerate via `prisma generate`.
3. `presentConfirmCard` registered; registry test passes 22 tools.
4. `consumeIntentService` is concurrency-safe (race-safe test passes).
5. HTTP route returns the codes in §8 for the corresponding inputs.
6. `chat_messages.blocks` contains a `confirm_card` block when the LLM calls `presentConfirmCard` (verified by turn-handler test).
7. All new tests pass (~28 cases).
8. Baseline 77 files / 635 tests → 81 files / ~663 tests. No regressions.
9. System prompt sentence extended per §9.
10. No new dependency in `package.json`.

---

## 13. Excluded scope

- `categorize_card`, `schedule_form`, `budget_edit` block types — separate follow-up plans.
- Reject endpoint (`POST /intents/:id/reject`). Client drops card on `✗`; server lets intent expire.
- Cron cleanup of consumed/expired intents.
- `audit_events` writes on consume — separate 1C-audit plan.
- Configurable TTL per intent (fixed 1 hour).
- Forcing any specific write tool through the intent flow (LLM still chooses per system prompt).
- Frontend renderer updates for `confirm_card` block (user's UI track).
- Translating tool-thrown errors during consume to specific HTTP codes — exception: `insufficient_role` is translated to 403 (see §3 + §8). Other tool errors (`category_not_found`, `invalid_amount`, etc.) surface as 500 in v1; a future plan can extend the mapping if needed.

---

## 14. Follow-up candidates

- **Plan 1C-categorize-card:** `presentCategorizeCard` for daily-ritual transaction categorization (uses the same intent infrastructure).
- **Plan 1C-confirmation-schedule** / **1C-confirmation-budget-edit:** form-style intent cards.
- **Plan 1C-audit:** `audit_events` table + link `intent_id` for every mutating action.
- **Plan 1C-intents-cron:** cleanup job for consumed/expired intents older than N days.
- **Plan 1C-confirmation-reject:** optional reject endpoint that records "user said no" for analytics.
