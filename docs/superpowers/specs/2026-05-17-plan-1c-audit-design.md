# Plan 1C-audit — audit_events durable write log

**Date:** 2026-05-17
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes + Confirmation, per master design §8 / §11.2)

---

## 1. Goal

Insert an `AuditEvent` row for every successful write-tool execution. Records
who (user id), how (agent = LLM-driven, user = explicit intent consume), what
(tool name + args + result + optional intent id), and when. Used for
debugging, user trust, and future privacy review.

No read surface (HTTP endpoint) in v1. No before/after state snapshots.

---

## 2. Background

Master design §8:

```
audit_events (id, workspace_id, actor_type: user/agent/system, actor_user_id?,
              action, target_type, target_id,
              before jsonb?, after jsonb?,
              originating_tool_call?, message_id?,
              created_at)
```

Master design §11.2 states: "Tool execution audit (모든 mutate → audit_events row)".
Today zero logging exists. This plan fills that gap for the 7 write tools
currently in the codebase.

---

## 3. Decisions

| Topic | Decision |
|---|---|
| before/after snapshots | Omitted — YAGNI. Future plan can add if privacy review demands it. |
| actorType for direct chat | `"agent"` — LLM initiated the action |
| actorType for intent consume | `"user"` — user explicitly tapped ✓ |
| actorUserId | Always the session user's id (never null) |
| Tools to log | 7: `categorizeTransaction` + the 6 CONFIRMABLE_TOOLS (`createCategory`, `addTransactionNote`, `setBudget`, `mapMerchantToCategory`, `addRecurring`, `removeRecurring`) |
| `presentConfirmCard` | NOT logged — it creates an intent but does not mutate data |
| Failure behavior | Fire-and-forget (`void + .catch(warn)`) — audit failure never blocks user action |
| HTTP read endpoint | Out of scope — no `GET /audit_events` in v1 |
| actor_type "system" | Out of scope — cron/webhook auditing is a separate plan |
| Retention / cleanup | Out of scope |
| CONFIRMABLE_TOOLS intent whitelist | Unchanged — `categorizeTransaction` is NOT added to the intent whitelist (no 2-phase confirm gate needed for it yet), only to the audit set |

---

## 4. Data model

```prisma
model AuditEvent {
  id          String   @id @default(cuid())
  workspaceId String
  actorType   String   // "agent" | "user"
  actorUserId String
  action      String   // tool name
  targetType  String?  // see §5
  targetId    String?  // see §5
  intentId    String?  // ActionIntent.id if via consume
  payload     Json?    // tool args (accept_action redacted per turn.ts policy)
  result      Json?    // tool result
  createdAt   DateTime @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, createdAt])
  @@map("audit_events")
}
```

Inverse relation: `Workspace { auditEvents AuditEvent[] }`.

Notes:
- No FK from `actorUserId` → `User` (users can be soft-deleted; audit records
  must survive beyond user deletion).
- No FK from `intentId` → `ActionIntent` (intents can be cleaned up later;
  audit records must survive).
- `payload` stores tool args AFTER redaction (the same redaction applied by
  `redactToolCallArgs` in turn.ts — `accept_action` stripped from
  `presentConfirmCard` never appears, and non-confirmation tools have no
  sensitive sub-fields today).

---

## 5. targetType and targetId mapping

| action | targetType | targetId source |
|---|---|---|
| `categorizeTransaction` | `"transaction"` | `result.tx.id` |
| `createCategory` | `"category"` | `result.category.id` |
| `addTransactionNote` | `"transaction"` | `result.tx.id` |
| `setBudget` | `"budget"` | `result.budget.id` |
| `mapMerchantToCategory` | `"merchant_mapping"` | `null` (keyed by merchantNormalized, no single row id) |
| `addRecurring` | `"recurring_expense"` | `result.recurring.id` |
| `removeRecurring` | `"recurring_expense"` | `null` (row deleted, id no longer meaningful) |

---

## 6. Service module

`apps/api/src/audit/service.ts`:

```typescript
export const AUDIT_WRITE_TOOLS = new Set([
  "categorizeTransaction",
  "createCategory",
  "addTransactionNote",
  "setBudget",
  "mapMerchantToCategory",
  "addRecurring",
  "removeRecurring",
]);

export function resolveTargetType(action: string): string | null;
export function extractTargetId(action: string, result: unknown): string | null;

export type AuditEventInput = {
  workspaceId: string;
  actorType: "agent" | "user";
  actorUserId: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  intentId?: string | null;
  payload?: unknown;
  result?: unknown;
};

export async function logAuditEvent(event: AuditEventInput): Promise<void>;
```

**`resolveTargetType`:** Returns the string from §5 mapping; unknown actions → `null`.

**`extractTargetId`:**

```typescript
export function extractTargetId(action: string, result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (action === "categorizeTransaction" || action === "addTransactionNote") {
    const tx = r.tx as Record<string, unknown> | undefined;
    return typeof tx?.id === "string" ? tx.id : null;
  }
  if (action === "createCategory") {
    const cat = r.category as Record<string, unknown> | undefined;
    return typeof cat?.id === "string" ? cat.id : null;
  }
  if (action === "setBudget") {
    const b = r.budget as Record<string, unknown> | undefined;
    return typeof b?.id === "string" ? b.id : null;
  }
  if (action === "addRecurring") {
    const rec = r.recurring as Record<string, unknown> | undefined;
    return typeof rec?.id === "string" ? rec.id : null;
  }
  return null;
}
```

**`logAuditEvent`:**

```typescript
export async function logAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        workspaceId: event.workspaceId,
        actorType: event.actorType,
        actorUserId: event.actorUserId,
        action: event.action,
        targetType: event.targetType ?? null,
        targetId: event.targetId ?? null,
        intentId: event.intentId ?? null,
        payload: (event.payload ?? null) as Prisma.InputJsonValue,
        result: (event.result ?? null) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.warn("audit log failed", { action: event.action, workspaceId: event.workspaceId, err });
  }
}
```

---

## 7. Hook locations

### 7.1 Direct chat execution (`apps/api/src/chat/turn.ts`)

In `processChatTurn`, after each tool call result is captured (but before
returning from the loop iteration), fire the audit log for write tools:

```typescript
import { AUDIT_WRITE_TOOLS, logAuditEvent, resolveTargetType, extractTargetId } from "../../audit/service.js";

// Inside the tool-execution loop, after dispatching and obtaining `dispatch`:
if (AUDIT_WRITE_TOOLS.has(fcName)) {
  const toolResult = dispatch.ok ? dispatch.result : null;
  void logAuditEvent({
    workspaceId: ctx.workspaceId,
    actorType: "agent",
    actorUserId: ctx.userId,
    action: fcName,
    targetType: resolveTargetType(fcName),
    targetId:   extractTargetId(fcName, toolResult),
    payload:    redactToolCallArgs(fcName, fcArgs),
    result:     toolResult,
  });
}
```

`presentConfirmCard` is NOT in `AUDIT_WRITE_TOOLS` so it is never logged here.

### 7.2 Intent consume (`apps/api/src/intents/service.ts`)

At the end of `consumeIntentService`, after `tool.run()` succeeds, fire the
audit log:

```typescript
import { AUDIT_WRITE_TOOLS, logAuditEvent, resolveTargetType, extractTargetId } from "../audit/service.js";

// After `const result = await tool.run(...)`:
void logAuditEvent({
  workspaceId: ctx.workspaceId,
  actorType: "user",
  actorUserId: ctx.userId,
  action: payload.tool,
  targetType: resolveTargetType(payload.tool),
  targetId:   extractTargetId(payload.tool, result),
  intentId:   intentId,
  payload:    payload.args,
  result:     result,
});
```

---

## 8. Files

- **Create** `apps/api/prisma/migrations/<ts>_add_audit_events/migration.sql`
- **Modify** `apps/api/prisma/schema.prisma` — `AuditEvent` model + `auditEvents AuditEvent[]` on `Workspace`
- **Create** `apps/api/src/audit/service.ts`
- **Modify** `apps/api/src/chat/turn.ts` — import + fire logAuditEvent for write tools
- **Modify** `apps/api/src/intents/service.ts` — import + fire logAuditEvent after consume
- **Create** `apps/api/tests/audit.service.test.ts` (~7 cases)

No new dependencies. No HTTP routes.

---

## 9. Tests

### 9.1 `audit.service.test.ts` (~7 cases)

1. `logAuditEvent` inserts a row with the correct `actorType`, `actorUserId`, `action`, `targetType`, `targetId`, `workspaceId`.
2. `logAuditEvent` does NOT throw on DB error (insert into bad workspace → Prisma FK error → caught and warned, returns normally).
3. `resolveTargetType("createCategory")` → `"category"`.
4. `resolveTargetType("removeRecurring")` → `"recurring_expense"`.
5. `resolveTargetType("mapMerchantToCategory")` → `null`.
6. `extractTargetId("createCategory", { category: { id: "c1" } })` → `"c1"`.
7. `extractTargetId("removeRecurring", { removed: true })` → `null`.

### 9.2 Integration (included in test file)

8. `processChatTurn` write tool path creates an `audit_events` row with `actorType: "agent"`. Use the existing `chat.turn.test.ts` stub pattern to mock Gemini emitting a `createCategory` tool call; assert an `AuditEvent` row exists in DB afterward.

9. `consumeIntentService` creates an `audit_events` row with `actorType: "user"` and `intentId` set. Create a real intent via `createIntentService`, consume it, assert the row.

10. `presentConfirmCard` via the dispatch does NOT create any `audit_events` row (call `processChatTurn` with a stub that emits `presentConfirmCard`; assert no audit row).

---

## 10. Acceptance criteria

1. Migration applies cleanly on both `fina` and `fina_test` DBs.
2. All 10 test cases pass.
3. `logAuditEvent` failure never throws to the caller — proven by test case 2.
4. baseline 81/665 → **82 files / ~675 tests**. No regressions.
5. No new dependency in `package.json`.

---

## 11. Excluded scope

- `GET /audit_events` HTTP endpoint.
- `before`/`after` state snapshots.
- `actor_type: "system"` for cron/webhook events.
- Retention / cleanup of old rows.
- `addTransaction` write tool — not yet implemented; add to audit set when built.
- Real-time audit UI.
- Indexing beyond `(workspaceId, createdAt)`.

---

## 12. Follow-up candidates

- **Plan 1C-audit-read:** `GET /workspaces/:id/audit_events` with pagination.
- **Plan 1C-audit-system:** Log cron + webhook events with `actorType: "system"`.
- **Plan 1C-audit-before-after:** Before/after snapshots per tool (requires per-tool DB read before mutation).
- **Plan 1C-audit-retention:** Cron cleanup of events older than N days.
