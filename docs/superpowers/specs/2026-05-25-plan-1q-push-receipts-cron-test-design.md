# Plan 1Q-push-receipts-cron-test Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1P (trial-expiring + goal-milestones crons). Closes Plan 1P §7 follow-up #1.

## 1. Goal & scope

`apps/api/src/cron/jobs/push-receipts.ts` (104 LOC) polls Expo for ticket receipts of pushes sent ≥1h ago. It has **zero** test coverage despite handling:

- `DeviceNotRegistered` → cascading UserDevice delete (FK CASCADE deletes PushTicket rows)
- `InvalidCredentials` → critical structured log (operator action)
- Other errors → warn + errorCode
- "receipt not ready" → leave polledAt null for retry
- **Same-batch cascade guard** — if ticket A's DNR deletes UserDevice X, later ticket B in same batch for the same X is SKIPPED via in-memory `deletedDeviceIds` set (prevents P2025 record-not-found throw)
- Expo SDK throw → logError + early return

Add **10 tests** in 1 commit covering all 7 branches + 2 boundary cases.

**Out of scope:**
- `take: 200` boundary (seed 250, expect 200 processed) — gold-plating; trust Prisma.
- `chunkPushNotificationReceiptIds` — production code defers to ≤300 limit; not exercised at 200.
- `Brief.morningBrief` linkage (separate cron).
- `cleanup-events` cron's 7-day stale-ticket pruning — separate plan.

## 2. Shared library touchpoints

**없음.** No `@fina/shared` exports change. `CRON_NAME` is file-local. Pure test addition in `apps/api`.

## 3. Production change

**없음.** `push-receipts.ts` unchanged.

## 4. Test file — `apps/api/tests/cron.push-receipts.test.ts` (new, 10 tests)

**Mock pattern**: same as `push.send.test.ts` lines 12-25 — module-level `vi.mock("expo-server-sdk")` with prototype-method `Expo` class. Per-test `vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync")` controls the receipts map.

`afterEach(vi.restoreAllMocks)` — spies on the mocked prototype, NOT replacing an export, so `restoreAllMocks` works (precedent: Plan 1N `push.send.test.ts:28`).

### File header (verbatim)

```ts
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

vi.mock("expo-server-sdk", () => {
  return {
    Expo: class {
      static isExpoPushToken(t: string) { return /^ExponentPushToken\[/.test(t); }
      chunkPushNotificationReceiptIds(ids: string[]) { return [ids]; }
      async getPushNotificationReceiptsAsync(_ids: string[]): Promise<unknown> {
        return {};  // default — tests override via vi.spyOn
      }
    },
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.restoreAllMocks(); });
```

### Helpers (local, not exported)

```ts
let counter = 0;

async function createUserDevice(): Promise<string> {
  counter++;
  const u = await prisma.user.create({
    data: {
      id: `pr-u-${Date.now()}-${counter}`,
      email: `pr-${Date.now()}-${counter}@t.co`,
      name: `PR User ${counter}`,
    },
  });
  const d = await prisma.userDevice.create({
    data: {
      userId: u.id,
      expoPushToken: `ExponentPushToken[pr-${counter}]`,
      platform: "ios",
    },
  });
  return d.id;
}

async function createTicket(opts: {
  deviceId: string;
  ticketId: string;
  sentAt?: Date;  // defaults to 2h ago (within polling window)
  polledAt?: Date | null;
}): Promise<string> {
  const t = await prisma.pushTicket.create({
    data: {
      userDeviceId: opts.deviceId,
      expoTicketId: opts.ticketId,
      sentAt: opts.sentAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000),  // 2h ago
      polledAt: opts.polledAt ?? null,
    },
  });
  return t.id;
}

async function mockReceipts(map: Record<string, unknown>) {
  const { Expo } = await import("expo-server-sdk");
  vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync").mockResolvedValue(map);
}
```

### 10 test scenarios

| # | Setup | Mocked receipts response | Expected |
|---|---|---|---|
| 1 | No tickets in DB | — | Early return, no Expo call. Verify via `vi.mocked(Expo.prototype.getPushNotificationReceiptsAsync)` spy `toHaveBeenCalledTimes(0)`. |
| 2 | Ticket sentAt = 30 minutes ago (within 1h window) | — | Filter excludes; no Expo call. `expect(spy).toHaveBeenCalledTimes(0)`. |
| 3 | Ticket already polledAt (≠ null), sentAt 2h ago | — | Filter excludes; no Expo call. |
| 4 | 1 ticket sentAt 2h ago, polledAt null | `mockResolvedValueOnce({})` (Expo doesn't have it yet) | spy called once. Ticket UNCHANGED (`polledAt` STILL null). |
| 5 | 1 ticket, status ok | `{ "tick-1": { status: "ok" } }` | Ticket updated: `polledAt !== null`, `status === "ok"`, `errorCode === null`. |
| 6 | 1 UserDevice + 1 ticket, DNR error | `{ "tick-2": { status: "error", message: "...", details: { error: "DeviceNotRegistered" } } }` | UserDevice deleted (`count === 0`). Ticket also deleted via FK CASCADE (`pushTicket.count === 0`). |
| 7 | 1 ticket, InvalidCredentials error | `{ "tick-3": { status: "error", message: "creds bad", details: { error: "InvalidCredentials" } } }` | Ticket updated: `status === "error"`, `errorCode === "InvalidCredentials"`, `polledAt !== null`. UserDevice **NOT** deleted. |
| 8 | 1 ticket, MessageRateExceeded error | `{ "tick-4": { status: "error", message: "...", details: { error: "MessageRateExceeded" } } }` | Ticket updated: `status === "error"`, `errorCode === "MessageRateExceeded"`. UserDevice NOT deleted. |
| 9 | **Same-batch cascade guard**: 1 UserDevice + 2 tickets (`tick-A` sentAt 3h ago, `tick-B` sentAt 2h ago — orderBy asc → A processed first) | `{ "tick-A": DNR, "tick-B": ok }` | Cron does NOT throw P2025. UserDevice deleted (count=0). Both tickets gone via CASCADE (`pushTicket.count === 0`). |
| 10 | Expo SDK throws (`mockRejectedValueOnce(new Error("network"))`) | rejected | Cron does NOT throw. logError called. Ticket UNCHANGED (`polledAt` still null). |

**Assertion pattern**:
- Use `vi.mocked(Expo.prototype.getPushNotificationReceiptsAsync).mock.calls.length` for spy count.
- Use direct `prisma.pushTicket.findUnique` / `findMany` / `count` for DB state after `runPushReceipts(env)`.
- Test 10's "logError called" not explicitly asserted (no logger spy); the load-bearing assertion is "cron does not throw + no state mutation" — same pattern as Plan 1P T1 #9.

**Commit:** `test(api): cron/push-receipts — 10 tests covering receipt polling state machine`

## 5. Risks

| Risk | Mitigation |
|---|---|
| Expo class signature drift — `getPushNotificationReceiptsAsync` is a prototype method. | Module-level `vi.mock("expo-server-sdk")` defines it as a prototype method, matching real SDK. Precedent: `push.send.test.ts:12-25`. |
| `chunkPushNotificationReceiptIds` not used in production (≤200 ≤300) but mock defines a stub. | Harmless — never called by code under test. Stub returns `[ids]` (single chunk) for safety if production usage shifts. |
| Test 9's deletion order — `orderBy: { sentAt: "asc" }` makes `tick-A` (3h ago) process before `tick-B` (2h ago). | Explicit sentAt offsets in helper. |
| `pushTicket.userDevice` FK with `onDelete: Cascade` (schema line 668) → DNR delete on UserDevice cascades to all related tickets. Critical to test 6 and test 9 expectations. | Schema-verified. `prisma.pushTicket.count()` after run confirms. |
| `sentAt: { lt: oneHourAgo }` boundary — at exactly 1h ago, ticket is NOT included (strict `<`). | Test 2 uses 30m ago, test 4+ use 2h ago. Boundary noted but not separately tested. |
| `userDevice.deleteMany` vs `.delete` — production uses `deleteMany` for idempotence. P2025 wouldn't fire on missing row, but FK CASCADE still works. | Per code comment lines 63-66. Test 6 confirms CASCADE happens. |
| Real DB pollution between tests | `truncateAll` in beforeEach. Per Plan 1M/1P precedent. |
| `vi.spyOn(Expo.prototype, ...)` cross-test leakage | `afterEach(vi.restoreAllMocks)` restores prototype methods. Module-level `vi.mock("expo-server-sdk")` is NOT restored (only spies are). Plan 1N precedent. |
| Expo SDK chunk limit (300) — production take:200 stays safe. | Out of scope per §1. |

## 6. Success criteria

- 10 new tests pass.
- Full `@fina/api` suite regression: 0 NEW fails.
- Typecheck baseline unchanged.
- 1 commit, test-only.

## 7. Follow-ups (별도 plans)

- `take: 200` boundary test (seed 250 tickets, expect 200 polled in 1 tick, remaining 50 next tick).
- `cleanup-events` cron's 7-day pruning of stale tickets.
- `chunkPushNotificationReceiptIds` integration if take ever exceeds 300.
- HTTP route → cron integration (Plan 1P §7 #3 — coming as Plan 1S).
- `computeGoalSavings` direct unit (Plan 1P §7 #2 — coming as Plan 1R).
