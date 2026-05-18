# Plan 1C-audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert an `AuditEvent` row for every write-tool dispatch that completes without a framework-level error (`dispatch.ok = true`) in both the direct chat path and the intent-consume path.

**Architecture:** New `AuditEvent` Prisma model. Shared `apps/api/src/audit/service.ts` provides `AUDIT_WRITE_TOOLS`, `resolveTargetType`, `extractTargetId`, and the fire-and-forget `logAuditEvent`. Two hook points: `processChatTurn` (actorType = "agent") and `consumeIntentService` (actorType = "user"). Failure never propagates — all errors are caught and warned internally.

**Tech Stack:** TypeScript ESM monorepo, Fastify, Prisma + Postgres on 5433, Vitest (singleFork).

**Spec:** [`docs/superpowers/specs/2026-05-17-plan-1c-audit-design.md`](../specs/2026-05-17-plan-1c-audit-design.md)

**Worktree:** This plan should be implemented in an isolated worktree branched from main. The subagent-driven-development skill will set this up via `EnterWorktree`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/prisma/schema.prisma` | Add `AuditEvent` model + `auditEvents AuditEvent[]` on `Workspace` |
| `apps/api/prisma/migrations/<ts>_add_audit_events/migration.sql` | DDL: table + index + FK |
| `apps/api/src/audit/service.ts` | `AUDIT_WRITE_TOOLS`, `resolveTargetType`, `extractTargetId`, `logAuditEvent` |
| `apps/api/src/chat/turn.ts` | Import + fire logAuditEvent for write tools after successful dispatch |
| `apps/api/src/intents/service.ts` | Import + fire logAuditEvent after successful consume dispatch |
| `apps/api/tests/audit.service.test.ts` | ~10 cases (unit + integration) |

No new dependencies. No HTTP routes.

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

**Expected:** `fina-postgres-dev: Up …`. Both `db:deploy` "No pending migrations". Test suite: `81 passed / 665 passed`.

---

## Task 1: Prisma model + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_add_audit_events/migration.sql`

### 1.1 Add the Prisma model

- [ ] **Step 1: Edit `apps/api/prisma/schema.prisma`**

Append the new model (place after `ActionIntent`):

```prisma
model AuditEvent {
  id          String   @id @default(cuid())
  workspaceId String
  actorType   String
  actorUserId String
  action      String
  targetType  String?
  targetId    String?
  intentId    String?
  payload     Json?
  result      Json?
  createdAt   DateTime @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)

  @@index([workspaceId, createdAt])
  @@map("audit_events")
}
```

Add inverse relation in `model Workspace { ... }`:
```prisma
  auditEvents AuditEvent[]
```

### 1.2 Generate + apply migration

- [ ] **Step 2: Generate migration skeleton**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_audit_events 2>&1 | tail -20
```

READ the generated `migration.sql`. It should contain:
- `CREATE TABLE "audit_events"` with 10 columns
- `CREATE INDEX "audit_events_workspaceId_createdAt_idx" ON "audit_events"("workspaceId", "createdAt")`
- 1 FK constraint (workspace → CASCADE)

Strip any unrelated `DROP INDEX` stub (recurring on prior plans for the NULLS LAST chat_threads index).

- [ ] **Step 3: Apply to both DBs + regen**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy 2>&1 | tail -5
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy 2>&1 | tail -5
pnpm --filter @fina/api exec prisma generate 2>&1 | tail -2
```

- [ ] **Step 4: Confirm baseline still passes**

```bash
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** 81 files / 665 tests still PASS.

### 1.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(plan 1c-audit): AuditEvent model + migration"
```

---

## Task 2: audit service (TDD)

**Files:**
- Create: `apps/api/src/audit/service.ts`
- Create: `apps/api/tests/audit.service.test.ts`

### 2.1 Write the failing tests

- [ ] **Step 1: Create `apps/api/tests/audit.service.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  AUDIT_WRITE_TOOLS,
  resolveTargetType,
  extractTargetId,
  logAuditEvent,
} from "../src/audit/service.js";

describe("resolveTargetType", () => {
  it("maps createCategory → 'category'", () => {
    expect(resolveTargetType("createCategory")).toBe("category");
  });
  it("maps removeRecurring → 'recurring_expense'", () => {
    expect(resolveTargetType("removeRecurring")).toBe("recurring_expense");
  });
  it("maps mapMerchantToCategory → 'merchant_mapping'", () => {
    expect(resolveTargetType("mapMerchantToCategory")).toBe("merchant_mapping");
  });
  it("returns null for unknown action", () => {
    expect(resolveTargetType("unknownTool")).toBeNull();
  });
});

describe("extractTargetId", () => {
  it("extracts id from createCategory result", () => {
    expect(
      extractTargetId("createCategory", { category: { id: "c1", name: "Coffee" } }),
    ).toBe("c1");
  });
  it("extracts id from addRecurring result", () => {
    expect(
      extractTargetId("addRecurring", { recurring: { id: "r1", name: "Netflix" } }),
    ).toBe("r1");
  });
  it("returns null for removeRecurring (row deleted)", () => {
    expect(extractTargetId("removeRecurring", { removed: true })).toBeNull();
  });
  it("returns null for mapMerchantToCategory (no row id)", () => {
    expect(
      extractTargetId("mapMerchantToCategory", {
        mapping: { merchantNormalized: "starbucks", categoryId: "c1", categoryName: "Coffee" },
        backfilledCount: 2,
      }),
    ).toBeNull();
  });
  it("returns null for missing or malformed result", () => {
    expect(extractTargetId("createCategory", null)).toBeNull();
    expect(extractTargetId("createCategory", {})).toBeNull();
  });
});

describe("logAuditEvent", () => {
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `au-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "AU", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "au-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("inserts a row with correct fields", async () => {
    await logAuditEvent({
      workspaceId,
      actorType: "agent",
      actorUserId: userId,
      action: "createCategory",
      targetType: "category",
      targetId: "c1",
      payload: { name: "Coffee" },
      result: { category: { id: "c1", name: "Coffee" } },
    });
    const row = await prisma.auditEvent.findFirst({
      where: { workspaceId },
    });
    expect(row).not.toBeNull();
    expect(row?.actorType).toBe("agent");
    expect(row?.actorUserId).toBe(userId);
    expect(row?.action).toBe("createCategory");
    expect(row?.targetType).toBe("category");
    expect(row?.targetId).toBe("c1");
    expect(row?.intentId).toBeNull();
  });

  it("includes intentId when provided", async () => {
    await logAuditEvent({
      workspaceId,
      actorType: "user",
      actorUserId: userId,
      action: "removeRecurring",
      intentId: "int-123",
      result: { removed: true },
    });
    const row = await prisma.auditEvent.findFirst({ where: { workspaceId } });
    expect(row?.intentId).toBe("int-123");
    expect(row?.actorType).toBe("user");
  });

  it("does NOT throw when workspace does not exist (FK error caught internally)", async () => {
    // non-existent workspace will cause a FK violation — must be swallowed
    await expect(
      logAuditEvent({
        workspaceId: "does-not-exist",
        actorType: "agent",
        actorUserId: userId,
        action: "createCategory",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("AUDIT_WRITE_TOOLS", () => {
  it("contains all 7 expected tool names", () => {
    for (const t of [
      "categorizeTransaction",
      "createCategory",
      "addTransactionNote",
      "setBudget",
      "mapMerchantToCategory",
      "addRecurring",
      "removeRecurring",
    ]) {
      expect(AUDIT_WRITE_TOOLS.has(t)).toBe(true);
    }
  });
  it("does NOT contain presentConfirmCard", () => {
    expect(AUDIT_WRITE_TOOLS.has("presentConfirmCard")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/audit.service.test.ts --reporter=basic 2>&1 | tail -10
```

### 2.2 Implement the service

- [ ] **Step 3: Create `apps/api/src/audit/service.ts`**

```typescript
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export const AUDIT_WRITE_TOOLS = new Set([
  "categorizeTransaction",
  "createCategory",
  "addTransactionNote",
  "setBudget",
  "mapMerchantToCategory",
  "addRecurring",
  "removeRecurring",
]);

const TARGET_TYPE_MAP: Record<string, string> = {
  categorizeTransaction: "transaction",
  createCategory: "category",
  addTransactionNote: "transaction",
  setBudget: "budget",
  mapMerchantToCategory: "merchant_mapping",
  addRecurring: "recurring_expense",
  removeRecurring: "recurring_expense",
};

export function resolveTargetType(action: string): string | null {
  return TARGET_TYPE_MAP[action] ?? null;
}

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
  // mapMerchantToCategory: keyed by merchantNormalized, no single row id
  // removeRecurring: row deleted, id no longer meaningful
  return null;
}

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
    console.warn("audit log failed", {
      action: event.action,
      workspaceId: event.workspaceId,
      err,
    });
  }
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/audit.service.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** all cases pass (count ≥ 13 — 4 resolveTargetType + 5 extractTargetId + 3 logAuditEvent + 2 AUDIT_WRITE_TOOLS = 14).

### 2.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/audit/service.ts apps/api/tests/audit.service.test.ts
git commit -m "feat(plan 1c-audit): audit service — logAuditEvent, resolveTargetType, extractTargetId"
```

---

## Task 3: Hook into turn.ts + intents/service.ts

**Files:**
- Modify: `apps/api/src/chat/turn.ts`
- Modify: `apps/api/src/intents/service.ts`

### 3.1 Turn.ts hook (direct chat writes)

- [ ] **Step 1: READ `apps/api/src/chat/turn.ts`** before editing. Locate:
  - The tool dispatcher loop (where `fcName`, `fcArgs`, and `dispatch` are declared).
  - Where `dispatch.ok` is checked and `dispatch.result` is accessed.
  - The existing `REDACTED_TOOL_ARGS` import (from this same file).

- [ ] **Step 2: Add import at top of `apps/api/src/chat/turn.ts`**

```typescript
import {
  AUDIT_WRITE_TOOLS,
  logAuditEvent,
  resolveTargetType,
  extractTargetId,
} from "../audit/service.js";
```

- [ ] **Step 3: Add the audit hook in turn.ts**

After the block that already computes `dispatch` and its result, inside the tool-execution loop, add:

```typescript
if (AUDIT_WRITE_TOOLS.has(fcName) && dispatch.ok) {
  void logAuditEvent({
    workspaceId: ctx.workspaceId,
    actorType: "agent",
    actorUserId: ctx.userId,
    action: fcName,
    targetType: resolveTargetType(fcName),
    targetId:   extractTargetId(fcName, dispatch.result),
    payload:    redactToolCallArgs(fcName, fcArgs),
    result:     dispatch.result,
  });
}
```

Note: `ctx` in `processChatTurn` is the `{ id: string; workspaceId: string }` thread ref. The user id is a separate parameter. Depending on the actual function signature, use the correct variable names (e.g. the function signature is `processChatTurn(env, thread, userId, role)`; so use `userId` and `thread.workspaceId`). Read the existing function signature before placing the call.

`presentConfirmCard` is NOT in `AUDIT_WRITE_TOOLS` so it is never logged.

### 3.2 intents/service.ts hook (consume writes)

- [ ] **Step 4: READ `apps/api/src/intents/service.ts`**. Find `consumeIntentService` and locate where `tool.run()` returns `result`.

- [ ] **Step 5: Add import at top of `apps/api/src/intents/service.ts`**

```typescript
import {
  AUDIT_WRITE_TOOLS,
  logAuditEvent,
  resolveTargetType,
  extractTargetId,
} from "../audit/service.js";
```

- [ ] **Step 6: Add the audit hook in consumeIntentService**

Immediately after `const result = await tool.run(...)`:

```typescript
if (AUDIT_WRITE_TOOLS.has(payload.tool)) {
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
}
```

`consumeIntentService` always runs a confirmable tool — all are in `AUDIT_WRITE_TOOLS` — so this fires every time. The `intentId` argument is the id of the `ActionIntent` row that was consumed.

### 3.3 Verify existing tests still pass

- [ ] **Step 7: Run the full API suite**

```bash
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** 82 files / ~679 tests PASS (81 + 1 new test file; 665 + 14 new cases). No regression in any existing file.

### 3.4 Commit

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/chat/turn.ts apps/api/src/intents/service.ts
git commit -m "feat(plan 1c-audit): hook logAuditEvent into turn + intents consume"
```

---

## Task 4: Full suite + final sanity

**Files:** none (verification only).

### 4.1 Run the full API suite via nx

- [ ] **Step 1: Reset nx + run**

```bash
pnpm exec nx reset 2>&1 | tail -2
pnpm nx run api:test --skipNxCache 2>&1 | tail -10
```

**Expected:** 82 files / ~679 tests PASS (±2 if any existing assertion count differs).

### 4.2 Sanity grep

- [ ] **Step 2: Confirm wiring**

```bash
grep -rn "logAuditEvent\|AUDIT_WRITE_TOOLS\|AuditEvent" apps/api/src/ | head -15
```

**Expected:**
- `audit/service.ts` exports `AUDIT_WRITE_TOOLS`, `logAuditEvent`, `resolveTargetType`, `extractTargetId`.
- `chat/turn.ts` imports + fires `logAuditEvent` for write tools.
- `intents/service.ts` imports + fires `logAuditEvent` after consume dispatch.

### 4.3 Confirm no new dependency

- [ ] **Step 3: Check `package.json`**

```bash
git diff main -- apps/api/package.json package.json
```

**Expected:** no output (unchanged).

---

## Self-Review Checklist (after all tasks)

1. **Spec coverage:** §4 model, §5 targetType mapping, §6 service, §7 hooks, §9 tests all covered.
2. **Hook in turn.ts fires ONLY when `dispatch.ok = true`** (spec §7.1).
3. **`presentConfirmCard` NOT in `AUDIT_WRITE_TOOLS`** (spec §3).
4. **`categorizeTransaction` IN `AUDIT_WRITE_TOOLS`** even though it's not in `CONFIRMABLE_TOOLS` (spec §3 note).
5. **Fire-and-forget** — `void` + internal try/catch. No throw escapes.
6. **Import path** in turn.ts: `../audit/service.js` (NOT `../../audit/service.js`).

---

## Known limitations (documented in spec §11)

- No `GET /audit_events` HTTP endpoint.
- No before/after state snapshots.
- `actorType: "system"` for cron/webhook not covered.
- `removeRecurring { removed: false }` is logged with `ok = true` — the result field shows no mutation occurred.
- No retention / cleanup.

These are listed so a reviewer doesn't ask "why didn't you also fix X?" — the answer is "Section §11 of the spec".
