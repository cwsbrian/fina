# Plan 2C-push-receipts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hourly cron polls Expo receipts for sent push tickets, cascades `DeviceNotRegistered` to `UserDevice` deletion, surfaces `InvalidCredentials` as critical structured logs, and lets `cleanup-events` reap polled rows > 7 days old.

**Architecture:** 5 task-commits, shared-first. New `PushTicket` Prisma model + back-ref → `sendBriefPush` hoists `deviceId` and persists ok-status tickets → new `push-receipts` cron at `0 * * * *` queries `polledAt: null AND sentAt < 1h ago` FIFO, calls `expo.getPushNotificationReceiptsAsync`, branches per receipt with same-batch cascade guard → `cleanup-events` extended with 7-day TTL deleteMany.

**Tech Stack:** Fastify 5 + Prisma 5 + `expo-server-sdk@^6.1.0` (already installed) + croner. Tests: Vitest singleFork, real Postgres on port 5433, prototype-method Expo mock pattern + `vi.spyOn(loggerMod, ...)` for log assertions.

---

## Context — read before any task

- **Spec:** `docs/superpowers/specs/2026-05-24-plan-2c-push-receipts-design.md` (HEAD `a3611f8`). Authoritative.
- **Predecessors shipped:** Plan 2C-push (`5c2da1b`) + Plan 2C-push-cleanup (`8bb189d`). UserDevice table, sendBriefPush with `__deviceId` carrier, EXPO_ACCESS_TOKEN env, all 5 push cron jobs (incl. daily-brief) all in place.
- **Worktree:** Implementation runs in `.worktrees/plan-2c-push-receipts` (created at implementation kickoff via `using-git-worktrees`).
- **CLAUDE.md rule:** `@fina/shared` 변경은 자기 commit으로 먼저, 그 후 consumer commit. T1이 강제함.
- **Test discipline:**
  - `vi.spyOn(prisma, ...)` and Prisma delegate properties FORBIDDEN (commit `3ecc538`). Use real DB + truncate.
  - `vi.spyOn(loggerMod, "logError" | "logWarn" | "logInfo").mockImplementation(() => {})` is the established pattern for log assertions (see `cron.scheduler.test.ts`, `plaid.webhook.routes.test.ts`).
  - `vi.mock("expo-server-sdk", ...)` factory uses PROTOTYPE methods for `sendPushNotificationsAsync` AND `getPushNotificationReceiptsAsync` so `vi.spyOn(Expo.prototype, ...)` works.
  - `afterEach(() => vi.restoreAllMocks())` is required in any file using spyOn under singleFork.
- **Patterns reused:**
  - `requireSession` not used in this plan (cron only).
  - `prisma` from `apps/api/src/db.js`.
  - `logInfo`/`logWarn`/`logError` from `apps/api/src/logger.js`.
  - `truncateAll`, `disconnect` from `apps/api/tests/helpers/db.js`.
  - `testEnv()` from `apps/api/tests/helpers/test-env.js`.
  - Cron skeleton — see existing `apps/api/src/cron/jobs/daily-refresh.ts` for `runX(env)` exported signature.

## File map

| File | Action | Task |
|---|---|---|
| `libs/shared/src/logging.ts` | Modify — add 5 push-receipts fields to `LogContext` | T1 |
| `apps/api/prisma/schema.prisma` | Modify — add `PushTicket` model + `UserDevice.tickets PushTicket[]` back-ref | T2 |
| `apps/api/prisma/migrations/<ts>_plan_2c_push_receipts/migration.sql` | Create — DDL for push_tickets table + FK + indexes | T2 |
| `apps/api/src/push/send.ts` | Modify — hoist `deviceId` to top of receipt loop, add `pushTicket.create()` for ok-status, remove inline duplicate in error branch | T3 |
| `apps/api/tests/push.send.test.ts` | Modify — add 1 new test "ok ticket persists PushTicket row" | T3 |
| `apps/api/src/cron/jobs/push-receipts.ts` | Create — `runPushReceipts(env)` cron handler | T4 |
| `apps/api/src/cron/scheduler.ts` | Modify — register `makeCron("0 * * * *", "push-receipts", ...)` | T4 |
| `apps/api/tests/push.receipts.test.ts` | Create — 6 cron tests | T4 |
| `apps/api/src/cron/jobs/cleanup-events.ts` | Modify — add PushTicket 7-day deleteMany step | T5 |
| `apps/api/tests/cron.cleanup-events.test.ts` | Modify — add 1 test for push_tickets cleanup | T5 |

---

## Task 1: `@fina/shared` — 5 LogContext push-receipts fields

**Goal:** Ship `LogContext` extension BEFORE any consumer code uses the new fields. CLAUDE.md hard rule.

**Files:**
- Modify: `libs/shared/src/logging.ts`

- [ ] **Step 1.1: Add 5 fields to `LogContext`**

In `libs/shared/src/logging.ts`, find the existing push cluster (right after `removedDeviceCount?: number;`). Add the new 5 fields adjacent to keep the cluster cohesive:

```ts
  /** Receipt polling cron (Plan 2C-push-receipts). */
  receiptsPolled?: number;
  receiptsFailed?: number;
  receiptInvalidCreds?: boolean;
  receiptErrorCode?: string;
  deletedPushTickets?: number;
```

- [ ] **Step 1.2: Typecheck shared lib**

```bash
pnpm --filter @fina/shared exec tsc --noEmit -p tsconfig.lib.json
```

Expected: no output.

- [ ] **Step 1.3: Commit**

```bash
git add libs/shared/src/logging.ts
git commit -m "feat(@fina/shared): receipt polling LogContext fields

5 fields added to LogContext (Plan 2C-push-receipts):
- receiptsPolled — Expo가 receipt 반환한 ticket 수 (해당 cron tick)
- receiptsFailed — status='error'로 받은 ticket 수
- receiptInvalidCreds — APNs/FCM cert 만료 시그널 (critical)
- receiptErrorCode — DeviceNotRegistered, MessageTooBig 등
- deletedPushTickets — cleanup-events에서 정리한 row 수

No new error codes / DTOs / zod schemas — just structured-log keys
so the new cron + cleanup step gets TS coverage on log payloads."
```

---

## Task 2: Prisma schema — `PushTicket` model + back-ref + migration

**Goal:** New `PushTicket` table with cascading FK to `UserDevice`. Migration applied to both `fina` and `fina_test`.

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_plan_2c_push_receipts/migration.sql`

- [ ] **Step 2.1: Update `schema.prisma`**

In `apps/api/prisma/schema.prisma`, find `model UserDevice { ... }`. After the existing relation(s), add:

```prisma
  tickets         PushTicket[]
```

Then at the bottom of the file, add the new model:

```prisma
model PushTicket {
  id              String       @id @default(cuid())
  /// Expo가 반환하는 ticket id (e.g., "019e5181-c4e6-7488..."). UNIQUE
  /// — 같은 ticket을 2번 저장 시도하면 conflict (방어용).
  expoTicketId    String       @unique
  userDeviceId    String
  sentAt          DateTime     @default(now())
  /// null = 아직 poll 안 함. Polling 성공 시 now(). 7일 후 cleanup-events 정리.
  polledAt        DateTime?
  /// null | "ok" | "error". status="error"일 때 errorCode 동반.
  status          String?
  /// "DeviceNotRegistered" | "InvalidCredentials" | "MessageTooBig" 등.
  errorCode       String?

  userDevice      UserDevice   @relation(fields: [userDeviceId], references: [id], onDelete: Cascade)

  @@index([polledAt, sentAt])
  @@map("push_tickets")
}
```

- [ ] **Step 2.2: Generate migration (or hand-write if non-interactive shell)**

Try the auto-gen first:

```bash
cd apps/api && pnpm exec prisma migrate dev --name plan_2c_push_receipts --create-only
```

If the shell is non-interactive (we saw this in 2C-push T2), Prisma will error out. Fall back to hand-writing `apps/api/prisma/migrations/<timestamp>_plan_2c_push_receipts/migration.sql` (replace `<timestamp>` with `date -u +%Y%m%d%H%M%S`):

```sql
-- CreateTable
CREATE TABLE "push_tickets" (
    "id" TEXT NOT NULL,
    "expoTicketId" TEXT NOT NULL,
    "userDeviceId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "polledAt" TIMESTAMP(3),
    "status" TEXT,
    "errorCode" TEXT,

    CONSTRAINT "push_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_tickets_expoTicketId_key" ON "push_tickets"("expoTicketId");

-- CreateIndex
CREATE INDEX "push_tickets_polledAt_sentAt_idx" ON "push_tickets"("polledAt", "sentAt");

-- AddForeignKey
ALTER TABLE "push_tickets" ADD CONSTRAINT "push_tickets_userDeviceId_fkey" FOREIGN KEY ("userDeviceId") REFERENCES "user_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 2.3: Apply to `fina_test`**

```bash
cd apps/api && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec prisma migrate deploy
```

Expected: "Following migration have been applied: ..._plan_2c_push_receipts".

- [ ] **Step 2.4: Apply to `fina` (dev)**

```bash
cd apps/api && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm exec prisma migrate deploy
```

Expected: same.

- [ ] **Step 2.5: Regenerate Prisma client**

```bash
pnpm --filter @fina/api exec prisma generate
```

Expected: "Generated Prisma Client".

- [ ] **Step 2.6: Verify DB**

```bash
psql "postgresql://fina:fina@localhost:5433/fina_test" -c "\d push_tickets"
```

Expected: table with 7 columns + unique index on `expoTicketId` + composite index on `(polledAt, sentAt)` + FK to `user_devices` with CASCADE.

- [ ] **Step 2.7: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same count as before T2 (only pre-existing baseline errors; no new `PushTicket`-related errors should appear since the model is now in Prisma client).

- [ ] **Step 2.8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(api): schema — PushTicket table for receipt polling

PushTicket(id, expoTicketId UNIQUE, userDeviceId, sentAt, polledAt?,
status?, errorCode?) with cascading FK to UserDevice. Composite
index on (polledAt, sentAt) optimizes the receipt-polling cron's
'polledAt IS NULL AND sentAt < now() - 1h' query.

UserDevice gains a 'tickets PushTicket[]' back-reference required by
Prisma's two-sided relation model — touched in the same diff so
schema validation passes.

Cron logic + sendBriefPush ticket persistence land in T3-T5."
```

---

## Task 3: `sendBriefPush` — hoist `deviceId` + persist ok tickets

**Goal:** Save ok-status ticket ids so the cron can poll them. Refactor the existing receipt loop so `deviceId` is in scope for both ok and error branches.

**Files:**
- Modify: `apps/api/src/push/send.ts`
- Modify: `apps/api/tests/push.send.test.ts`

- [ ] **Step 3.1: Read the existing `send.ts` ticket loop**

Open `apps/api/src/push/send.ts` and locate the `for (let i = 0; i < tickets.length; i++)` block (around lines 74-94). Confirm:
- Each iteration reads `const t = tickets[i]!`
- The error branch (line ~81) declares `const deviceId = (chunk[i] as CarrierMessage).__deviceId;` ONLY inside the error path
- The ok branch (line ~76) just does `sent++; continue;`

- [ ] **Step 3.2: Write failing test extension**

In `apps/api/tests/push.send.test.ts`, append a NEW test inside the existing `describe("sendBriefPush", ...)` block. Reuse the existing helpers (`makeUserWithDevices`, etc.). Place it after the "one device — calls Expo once, returns sent=1" test:

```ts
it("ok ticket → PushTicket row created with matching expoTicketId", async () => {
  const { Expo } = await import("expo-server-sdk");
  const u = await makeUserWithDevices([
    { token: "ExponentPushToken[ok-persists]", platform: "ios" },
  ]);
  const sendSpy = vi.fn().mockResolvedValueOnce([
    { status: "ok", id: "ticket_persist_1" },
  ]);
  vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);

  const { sendBriefPush } = await import("../src/push/send.js");
  const result = await sendBriefPush(testEnv(), u.id, "morning brief");

  expect(result.sent).toBe(1);
  const tickets = await prisma.pushTicket.findMany({
    where: { userDevice: { userId: u.id } },
  });
  expect(tickets).toHaveLength(1);
  expect(tickets[0]!.expoTicketId).toBe("ticket_persist_1");
  expect(tickets[0]!.polledAt).toBeNull();
  expect(tickets[0]!.status).toBeNull();
});
```

`testEnv` must be imported at the top of the file if not already; check existing imports.

- [ ] **Step 3.3: Run failing test**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/push.send.test.ts
```

Expected: the new test fails — `tickets` is `[]` because `sendBriefPush` doesn't persist anything yet. Existing 5 tests still pass.

- [ ] **Step 3.4: Refactor `send.ts` ticket loop**

Modify the loop in `apps/api/src/push/send.ts`. Hoist `deviceId` to top of each iteration, then insert ticket persistence in the ok branch:

```ts
for (let i = 0; i < tickets.length; i++) {
  const t = tickets[i]!;
  const deviceId = (chunk[i] as CarrierMessage).__deviceId;  // hoisted

  if (t.status === "ok") {
    // Persist ok tickets for receipt polling (Plan 2C-push-receipts).
    // Best-effort: a failure here shouldn't break the whole send.
    try {
      await prisma.pushTicket.create({
        data: { expoTicketId: t.id, userDeviceId: deviceId },
      });
    } catch (err) {
      logWarn(
        { userId, removedDeviceId: deviceId, err },
        "ticket persist failed",
      );
    }
    sent++;
    continue;
  }

  // Error branch — deviceId already in scope; remove the old inline
  // declaration if present.
  failed++;
  const errorCode = t.details?.error;
  if (errorCode === "DeviceNotRegistered") {
    await prisma.userDevice.delete({ where: { id: deviceId } });
    logInfo({ userId, removedDeviceId: deviceId }, "stale device removed");
  } else {
    logWarn(
      { userId, removedDeviceId: deviceId, err: t.message },
      "push send error (token kept)",
    );
  }
}
```

**Important**: delete the existing inline `const deviceId = (chunk[i] as CarrierMessage).__deviceId;` from the error branch (otherwise TS will complain about re-declaration).

- [ ] **Step 3.5: Run all push.send tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/push.send.test.ts
```

Expected: all 6 tests pass (5 existing + 1 new).

- [ ] **Step 3.6: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same count as before T3 (no new errors).

- [ ] **Step 3.7: Commit**

```bash
git add apps/api/src/push/send.ts apps/api/tests/push.send.test.ts
git commit -m "feat(api): sendBriefPush persists ok tickets for receipt polling

Each ExpoPushSuccessTicket.id now lands in push_tickets.expoTicketId
so the new push-receipts cron (T4) can poll Expo for async delivery
outcomes 1h+ after send.

Refactor: deviceId carrier read hoisted to top of the receipt loop
so it's in scope for both ok and error branches. Error branch's
inline duplicate removed.

Persistence is best-effort — catch + logWarn so a transient DB
failure doesn't break the whole send pipeline. sendBriefPush's
{ sent, failed } counters unchanged."
```

---

## Task 4: `push-receipts` cron — handler + scheduler registration + 6 tests

**Goal:** New `runPushReceipts(env)` cron + 6 integration tests + scheduler entry.

**Files:**
- Create: `apps/api/src/cron/jobs/push-receipts.ts`
- Modify: `apps/api/src/cron/scheduler.ts`
- Create: `apps/api/tests/push.receipts.test.ts`

- [ ] **Step 4.1: Write the 6 failing tests**

Create `apps/api/tests/push.receipts.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as loggerMod from "../src/logger.js";

// Prototype-method Expo mock — receipt API + send API both stubbed so
// vi.spyOn(Expo.prototype, ...) works in individual tests.
vi.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken(t: string) { return /^ExponentPushToken\[/.test(t); }
    chunkPushNotifications(messages: unknown[]) { return [messages]; }
    chunkPushNotificationReceiptIds(ids: string[]) { return [ids]; }
    async sendPushNotificationsAsync(_messages: unknown[]) { return []; }
    async getPushNotificationReceiptsAsync(_ids: string[]) { return {}; }
  },
}));

beforeAll(async () => { await truncateAll(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await disconnect(); });

async function makeUserDeviceWithTicket(opts: {
  email: string; token: string; expoTicketId: string; sentMinutesAgo: number;
}) {
  const u = await prisma.user.create({
    data: { id: `r-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            email: opts.email, name: "R" },
  });
  const device = await prisma.userDevice.create({
    data: { userId: u.id, expoPushToken: opts.token, platform: "ios" },
  });
  const ticket = await prisma.pushTicket.create({
    data: {
      expoTicketId: opts.expoTicketId,
      userDeviceId: device.id,
      sentAt: new Date(Date.now() - opts.sentMinutesAgo * 60 * 1000),
    },
  });
  return { user: u, device, ticket };
}

describe("runPushReceipts", () => {
  it("skips tickets younger than 1 hour", async () => {
    const { Expo } = await import("expo-server-sdk");
    const spy = vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync");
    await makeUserDeviceWithTicket({
      email: "rcpt-young@t.co",
      token: "ExponentPushToken[young]",
      expoTicketId: "ticket_young",
      sentMinutesAgo: 30,
    });

    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(testEnv());

    expect(spy).not.toHaveBeenCalled();
    const ticket = await prisma.pushTicket.findFirst({ where: { expoTicketId: "ticket_young" } });
    expect(ticket?.polledAt).toBeNull();
  });

  it("ok receipt → polledAt + status='ok'", async () => {
    const { Expo } = await import("expo-server-sdk");
    const { ticket } = await makeUserDeviceWithTicket({
      email: "rcpt-ok@t.co",
      token: "ExponentPushToken[ok]",
      expoTicketId: "ticket_ok",
      sentMinutesAgo: 90,
    });
    vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync").mockResolvedValueOnce({
      ticket_ok: { status: "ok" },
    });

    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(testEnv());

    const updated = await prisma.pushTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updated.polledAt).not.toBeNull();
    expect(updated.status).toBe("ok");
  });

  it("DeviceNotRegistered receipt → UserDevice deleted + ticket cascades", async () => {
    const { Expo } = await import("expo-server-sdk");
    const { device } = await makeUserDeviceWithTicket({
      email: "rcpt-dnr@t.co",
      token: "ExponentPushToken[dnr]",
      expoTicketId: "ticket_dnr",
      sentMinutesAgo: 90,
    });
    vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync").mockResolvedValueOnce({
      ticket_dnr: { status: "error", message: "stale", details: { error: "DeviceNotRegistered" } },
    });

    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(testEnv());

    // UserDevice gone, cascade removed the ticket too.
    const remainingDevice = await prisma.userDevice.findUnique({ where: { id: device.id } });
    expect(remainingDevice).toBeNull();
    const remainingTickets = await prisma.pushTicket.findMany({ where: { expoTicketId: "ticket_dnr" } });
    expect(remainingTickets).toHaveLength(0);
  });

  it("InvalidCredentials receipt → logError + receiptInvalidCreds + ticket marked", async () => {
    const { Expo } = await import("expo-server-sdk");
    const errSpy = vi.spyOn(loggerMod, "logError").mockImplementation(() => {});
    const { ticket } = await makeUserDeviceWithTicket({
      email: "rcpt-ic@t.co",
      token: "ExponentPushToken[ic]",
      expoTicketId: "ticket_ic",
      sentMinutesAgo: 90,
    });
    vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync").mockResolvedValueOnce({
      ticket_ic: { status: "error", message: "bad cert", details: { error: "InvalidCredentials" } },
    });

    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(testEnv());

    const updated = await prisma.pushTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updated.polledAt).not.toBeNull();
    expect(updated.status).toBe("error");
    expect(updated.errorCode).toBe("InvalidCredentials");
    // logError called at least once with receiptInvalidCreds:true in context
    const invalidCredsCalls = errSpy.mock.calls.filter(([ctx]) =>
      (ctx as { receiptInvalidCreds?: boolean })?.receiptInvalidCreds === true,
    );
    expect(invalidCredsCalls.length).toBeGreaterThan(0);
  });

  it("other error → logWarn + errorCode stored + ticket marked", async () => {
    const { Expo } = await import("expo-server-sdk");
    const warnSpy = vi.spyOn(loggerMod, "logWarn").mockImplementation(() => {});
    const { ticket } = await makeUserDeviceWithTicket({
      email: "rcpt-other@t.co",
      token: "ExponentPushToken[other]",
      expoTicketId: "ticket_other",
      sentMinutesAgo: 90,
    });
    vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync").mockResolvedValueOnce({
      ticket_other: { status: "error", message: "too big", details: { error: "MessageTooBig" } },
    });

    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(testEnv());

    const updated = await prisma.pushTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(updated.errorCode).toBe("MessageTooBig");
    expect(updated.status).toBe("error");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("receipt not yet ready (Expo returns empty for that id) → ticket unchanged, retried next tick", async () => {
    const { Expo } = await import("expo-server-sdk");
    const { ticket } = await makeUserDeviceWithTicket({
      email: "rcpt-pending@t.co",
      token: "ExponentPushToken[pending]",
      expoTicketId: "ticket_pending",
      sentMinutesAgo: 90,
    });
    vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync").mockResolvedValueOnce({});

    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(testEnv());

    const unchanged = await prisma.pushTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(unchanged.polledAt).toBeNull();
    expect(unchanged.status).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run failing tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/push.receipts.test.ts
```

Expected: ALL 6 fail with "Cannot find module '../src/cron/jobs/push-receipts.js'" or similar (module doesn't exist yet).

- [ ] **Step 4.3: Create `push-receipts.ts`**

Create `apps/api/src/cron/jobs/push-receipts.ts`:

```ts
import { Expo, type ExpoPushReceipt } from "expo-server-sdk";
import { prisma } from "../../db.js";
import { logError, logInfo, logWarn } from "../../logger.js";
import type { Env } from "../../env.js";

const CRON_NAME = "push-receipts";

/** Polls Expo for receipts of tickets sent >= 1 hour ago. Handles
 *  DeviceNotRegistered (cascading UserDevice delete), InvalidCredentials
 *  (critical structured log), other errors (warn + errorCode). Receipts
 *  not yet ready leave polledAt null for the next tick. */
export async function runPushReceipts(env: Env): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const pending = await prisma.pushTicket.findMany({
    where: { polledAt: null, sentAt: { lt: oneHourAgo } },
    orderBy: { sentAt: "asc" },  // FIFO; prevents starvation under flood
    take: 200,
    select: { id: true, expoTicketId: true, userDeviceId: true },
  });
  if (pending.length === 0) return;

  // expo-server-sdk does NOT auto-chunk getPushNotificationReceiptsAsync.
  // Receipt chunk limit is 300; our take:200 stays under. If raised, call
  // expo.chunkPushNotificationReceiptIds(ids) first.
  const expo = new Expo(
    env.EXPO_ACCESS_TOKEN === undefined ? {} : { accessToken: env.EXPO_ACCESS_TOKEN },
  );

  let receipts: Record<string, ExpoPushReceipt>;
  try {
    receipts = await expo.getPushNotificationReceiptsAsync(pending.map((t) => t.expoTicketId));
  } catch (err) {
    logError({ cron: CRON_NAME, err }, "expo getReceipts threw");
    return;  // next tick retries
  }

  let polled = 0;
  let failed = 0;
  let invalidCreds = false;
  // Same-batch cascade guard: if ticket A's DNR receipt deletes UserDevice X,
  // any later ticket pointing to X has been cascade-deleted. Skip those.
  const deletedDeviceIds = new Set<string>();

  for (const ticket of pending) {
    if (deletedDeviceIds.has(ticket.userDeviceId)) continue;

    const r = receipts[ticket.expoTicketId];
    if (!r) continue;  // Expo doesn't have receipt yet — next tick retries

    polled++;
    if (r.status === "ok") {
      await prisma.pushTicket.update({
        where: { id: ticket.id },
        data: { polledAt: new Date(), status: "ok" },
      });
      continue;
    }

    failed++;
    const errorCode = r.details?.error ?? "Unknown";

    if (errorCode === "DeviceNotRegistered") {
      // deleteMany (not delete) — idempotent. UserDevice may already be
      // gone if sendBriefPush's own DNR handler or 2C-push-cleanup's
      // sign-out DELETE fired in the meantime; we don't want P2025.
      await prisma.userDevice.deleteMany({ where: { id: ticket.userDeviceId } });
      deletedDeviceIds.add(ticket.userDeviceId);
      logInfo(
        { cron: CRON_NAME, removedDeviceId: ticket.userDeviceId, receiptErrorCode: errorCode },
        "device removed via receipt",
      );
      continue;
    }

    await prisma.pushTicket.update({
      where: { id: ticket.id },
      data: { polledAt: new Date(), status: "error", errorCode },
    });

    if (errorCode === "InvalidCredentials") {
      invalidCreds = true;
      logError(
        { cron: CRON_NAME, receiptInvalidCreds: true, receiptErrorCode: errorCode, err: r.message },
        "APNs/FCM credentials invalid — operator action required",
      );
    } else {
      logWarn(
        { cron: CRON_NAME, receiptErrorCode: errorCode, err: r.message },
        "receipt error",
      );
    }
  }

  logInfo(
    {
      cron: CRON_NAME,
      receiptsPolled: polled,
      receiptsFailed: failed,
      ...(invalidCreds ? { receiptInvalidCreds: true } : {}),
    },
    "receipts cron done",
  );
}
```

- [ ] **Step 4.4: Register in scheduler**

In `apps/api/src/cron/scheduler.ts`, add the import:

```ts
import { runPushReceipts } from "./jobs/push-receipts.js";
```

Then inside `startScheduler`, in the `jobs = [...]` array, add a 6th entry (place it adjacent to `daily-brief` so push-related crons cluster):

```ts
    makeCron("0 * * * *",    "push-receipts",         () => runPushReceipts(env)),
```

- [ ] **Step 4.5: Run tests — expect pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/push.receipts.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 4.6: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same count as before T4 (no new errors).

- [ ] **Step 4.7: Commit**

```bash
git add apps/api/src/cron/jobs/push-receipts.ts apps/api/src/cron/scheduler.ts apps/api/tests/push.receipts.test.ts
git commit -m "feat(api): push-receipts cron — hourly Expo receipt polling

Every hour on the hour, queries push_tickets where polledAt IS NULL
AND sentAt < now() - 1h (FIFO by sentAt, batch 200), calls
expo.getPushNotificationReceiptsAsync, and branches:

- status='ok' → polledAt + status='ok'
- DeviceNotRegistered → cascade-delete UserDevice (skip remaining
  tickets in batch pointing at same userDeviceId via Set guard, so
  cascade-deleted ticket rows don't throw P2025)
- InvalidCredentials → logError({ receiptInvalidCreds: true, ... })
  + mark ticket (APNs/FCM cert expiry → critical operator signal)
- other errors → logWarn + errorCode stored on ticket
- missing receipt (Expo not yet processed) → ticket unchanged,
  retried next tick

Scheduler gains a 6th cron at '0 * * * *'. Concurrent execution
with cleanup-events (03:00) and daily-refresh (09:00) is safe —
each Cron instance is independent, no shared in-memory state, and
Prisma is atomic per-statement.

Tests: 6 cases covering young-skip, ok, DNR cascade, InvalidCreds
log, other error, and pending-retry. Mocks Expo via prototype
methods so vi.spyOn(Expo.prototype, ...) works; logger spied via
vi.spyOn(loggerMod, ...) per existing cron.scheduler.test.ts /
plaid.webhook.routes.test.ts pattern."
```

---

## Task 5: `cleanup-events` cron — reap `polledAt > 7d` rows

**Goal:** Add a PushTicket cleanup step + 1 test.

**Files:**
- Modify: `apps/api/src/cron/jobs/cleanup-events.ts`
- Modify: `apps/api/tests/cron.cleanup-events.test.ts`

- [ ] **Step 5.1: Read existing `cleanup-events.ts`**

Read `apps/api/src/cron/jobs/cleanup-events.ts`. Confirm it has an N-step iterator pattern (multiple `prisma.X.deleteMany` calls with `logInfo` after each). Note the existing date pattern around line 14 (`new Date(Date.now() - ... * 86_400_000)`).

- [ ] **Step 5.2: Write failing test**

In `apps/api/tests/cron.cleanup-events.test.ts`, add a new test inside the existing describe block:

```ts
it("deletes push_tickets with polledAt > 7d ago; preserves recent rows", async () => {
  // Helper to make a UserDevice row.
  const u = await prisma.user.create({
    data: { id: `ce-${Date.now()}`, email: `ce-${Date.now()}@t.co`, name: "CE" },
  });
  const d = await prisma.userDevice.create({
    data: { userId: u.id, expoPushToken: "ExponentPushToken[ce]", platform: "ios" },
  });

  // Old ticket — polledAt 10 days ago.
  await prisma.pushTicket.create({
    data: {
      expoTicketId: "ticket_old",
      userDeviceId: d.id,
      polledAt: new Date(Date.now() - 10 * 86_400_000),
      status: "ok",
    },
  });
  // Recent ticket — polledAt 1 day ago.
  await prisma.pushTicket.create({
    data: {
      expoTicketId: "ticket_recent",
      userDeviceId: d.id,
      polledAt: new Date(Date.now() - 1 * 86_400_000),
      status: "ok",
    },
  });

  // Note: `runCleanupEvents` is already imported at top of test file
  // (`import { runCleanupEvents } from "../src/cron/jobs/cleanup-events.js"`).
  // Do NOT re-import dynamically — TS will flag redeclaration.
  await runCleanupEvents(testEnv());

  const remaining = await prisma.pushTicket.findMany({ orderBy: { expoTicketId: "asc" } });
  expect(remaining.map((r) => r.expoTicketId)).toEqual(["ticket_recent"]);
});
```

- [ ] **Step 5.3: Run failing test**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/cron.cleanup-events.test.ts
```

Expected: new test fails (old ticket still present — cleanup doesn't touch push_tickets yet).

- [ ] **Step 5.4: Extend `cleanup-events.ts`**

Locate `apps/api/src/cron/jobs/cleanup-events.ts`. The file has `const CRON_NAME = "cleanup-events";` at module top (~line 5) and the cleanup logic inside `runCleanupEvents(env)`. Append the new step at the END of the function body (after the last existing `deleteMany`/`logInfo` pair, before the closing `}` of the function):

```ts
  const pushTicketCutoff = new Date(Date.now() - 7 * 86_400_000);
  const pushTicketResult = await prisma.pushTicket.deleteMany({
    where: { polledAt: { lt: pushTicketCutoff } },
  });
  logInfo(
    { cron: CRON_NAME, deletedPushTickets: pushTicketResult.count },
    "push_tickets cleanup",
  );
```

The exact insertion point depends on the file's structure — use the closest existing `deleteMany` block as a template for indentation + style.

- [ ] **Step 5.5: Run tests — expect pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/cron.cleanup-events.test.ts
```

Expected: all tests pass (existing + 1 new).

- [ ] **Step 5.6: Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same count as before T5.

- [ ] **Step 5.7: Commit**

```bash
git add apps/api/src/cron/jobs/cleanup-events.ts apps/api/tests/cron.cleanup-events.test.ts
git commit -m "feat(api): cleanup-events reaps polled push_tickets > 7d

After the receipt-polling cron (T4) sets polledAt on a ticket, the
row is kept for 7 days for audit/observability, then deleted by
cleanup-events. Unpolled rows (Expo never returned receipt, e.g.
24h+ expired or systemic outage) are NOT touched here — those need
the v2 stale-ticket sweeper (out of scope for this plan).

logInfo with deletedPushTickets count for log-readable audit trail."
```

---

## Final verification

After all 5 tasks land:

- [ ] **Verify spec §10 success criteria**

```bash
# 1. push.receipts.test.ts new + push.send.test.ts +1 + cron.cleanup-events.test.ts +1:
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/push.receipts.test.ts tests/push.send.test.ts tests/cron.cleanup-events.test.ts 2>&1 | tail -6
# Expected: 8 NEW tests pass (6 push.receipts + 1 push.send + 1 cleanup-events).
# Plus all pre-existing tests in those files (5 in push.send + N in cleanup-events).

# 2. Full API suite (no regression):
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -6
# Expected: ~1061 pass (1053 prior + 8 new) plus 2 known plaid baseline flakes + 1 todo.

# 3. Typechecks (3 packages):
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
pnpm --filter @fina/mobile exec tsc --noEmit 2>&1 | grep "error TS" | wc -l
pnpm --filter @fina/shared exec tsc --noEmit -p tsconfig.lib.json 2>&1 | grep "error TS" | wc -l
# Expected: api count ≈ pre-T1 baseline (no new errors); mobile + shared zero.
```

- [ ] **Manual smoke (optional, post-merge)**

Per spec §10, after merge: send a brief, wait 1 hour, then `psql ... "SELECT id, status, polled_at FROM push_tickets WHERE polled_at IS NOT NULL"` should show row(s) with `status='ok'` and recent `polled_at`. Optional — automated tests already cover this path with mocked Expo.
