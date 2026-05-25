# Plan 1Q — push-receipts cron test coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add 10 tests for `runPushReceipts` covering the 7 production branches + 3 filter-predicate cases. 1 commit. Closes Plan 1P §7 follow-up #1.

**Architecture:** Module-level `vi.mock("expo-server-sdk")` defines an Expo class with prototype methods (matching real SDK). Per-test `vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync")` (via `mockReceipts` helper that returns the spy). Real Postgres :5433 + `truncateAll` in `beforeEach`. `afterEach(vi.restoreAllMocks)` restores spies; module-mock factory survives. Precedent: `apps/api/tests/push.send.test.ts:12-28`.

**Tech Stack:** Vitest 1.x, prisma, Expo SDK mock.

---

## File Structure

- **Create:** `apps/api/tests/cron.push-receipts.test.ts` — Task 1.

No production code changes. No `@fina/shared` changes.

---

## Task 1: `cron.push-receipts.test.ts` (10 tests, 1 commit)

**Files:**
- Create: `apps/api/tests/cron.push-receipts.test.ts`

- [ ] **Step 1: Read precedent + production**

Read `apps/api/tests/push.send.test.ts` lines 1-30 (mock setup precedent — same Expo-class mock).
Read `apps/api/src/cron/jobs/push-receipts.ts` end-to-end (104 LOC). Note key branches:
- L14-19: pending filter (`polledAt: null, sentAt: { lt: oneHourAgo }, take: 200, orderBy: { sentAt: "asc" }`)
- L20: empty pending → return
- L25-27: Expo constructor with optional `accessToken`
- L31-35: `getPushNotificationReceiptsAsync` throws → logError + return
- L45: `if (deletedDeviceIds.has(ticket.userDeviceId)) continue` — SAME-BATCH CASCADE GUARD
- L47-48: `!r` (receipt not ready) → continue
- L51-57: ok → `polledAt + status="ok"`
- L62-74: DNR → `userDevice.deleteMany` + add to set
- L76-92: any other error → ticket update + log (InvalidCredentials = error log, else warn)

PushTicket FK: `userDevice` with `onDelete: Cascade`. DNR → device delete → ticket CASCADE-deleted.

**Guardrail:** Do NOT edit `apps/api/src/cron/jobs/push-receipts.ts` or any other production file. Test-only addition.

- [ ] **Step 2: Create the test file**

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

// Mock Expo SDK at module level — prototype-method class so vi.spyOn can
// intercept getPushNotificationReceiptsAsync. Matches push.send.test.ts:12.
vi.mock("expo-server-sdk", () => {
  return {
    Expo: class {
      static isExpoPushToken(t: string) { return /^ExponentPushToken\[/.test(t); }
      chunkPushNotificationReceiptIds(ids: string[]) { return [ids]; }
      async getPushNotificationReceiptsAsync(_ids: string[]): Promise<unknown> {
        return {};
      }
    },
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.restoreAllMocks(); });

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
  sentAt?: Date;
  polledAt?: Date | null;
}): Promise<string> {
  const t = await prisma.pushTicket.create({
    data: {
      userDeviceId: opts.deviceId,
      expoTicketId: opts.ticketId,
      sentAt: opts.sentAt ?? new Date(Date.now() - 2 * 60 * 60 * 1000),
      polledAt: opts.polledAt ?? null,
    },
  });
  return t.id;
}

/** Spies on the mocked Expo prototype and returns the spy handle.
 *  Pass `{ throws: err }` to mock a rejection. */
async function mockReceipts(
  map: Record<string, unknown>,
  opts: { throws?: Error } = {},
): Promise<MockInstance> {
  const { Expo } = await import("expo-server-sdk");
  const spy = vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync");
  if (opts.throws) {
    spy.mockRejectedValue(opts.throws);
  } else {
    spy.mockResolvedValue(map);
  }
  return spy;
}

describe("runPushReceipts", () => {
  // 10 tests below
});
```

Then add the 10 `it()` blocks inside the describe:

**Test 1 — no tickets:**
```ts
  it("no tickets → no Expo call", async () => {
    const spy = await mockReceipts({});
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(env);
    expect(spy).toHaveBeenCalledTimes(0);
  });
```

**Test 2 — ticket too new (30m ago):**
```ts
  it("ticket sentAt 30m ago (within 1h window) → filtered, no Expo call", async () => {
    const deviceId = await createUserDevice();
    await createTicket({
      deviceId, ticketId: "tick-new",
      sentAt: new Date(Date.now() - 30 * 60 * 1000),
    });
    const spy = await mockReceipts({});
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(env);
    expect(spy).toHaveBeenCalledTimes(0);
  });
```

**Test 3 — already polled:**
```ts
  it("ticket already polledAt → filtered, no Expo call", async () => {
    const deviceId = await createUserDevice();
    await createTicket({
      deviceId, ticketId: "tick-done",
      polledAt: new Date(),
    });
    const spy = await mockReceipts({});
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(env);
    expect(spy).toHaveBeenCalledTimes(0);
  });
```

**Test 4 — receipt not ready:**
```ts
  it("Expo doesn't have receipt yet → ticket unchanged", async () => {
    const deviceId = await createUserDevice();
    const tid = await createTicket({ deviceId, ticketId: "tick-pending" });
    const spy = await mockReceipts({});  // empty receipts map
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(env);
    expect(spy).toHaveBeenCalledTimes(1);
    const fresh = await prisma.pushTicket.findUniqueOrThrow({ where: { id: tid } });
    expect(fresh.polledAt).toBeNull();
    expect(fresh.status).toBeNull();
  });
```

**Test 5 — ok receipt:**
```ts
  it("ok receipt → polledAt + status='ok'", async () => {
    const deviceId = await createUserDevice();
    const tid = await createTicket({ deviceId, ticketId: "tick-ok" });
    await mockReceipts({ "tick-ok": { status: "ok" } });
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(env);
    const fresh = await prisma.pushTicket.findUniqueOrThrow({ where: { id: tid } });
    expect(fresh.polledAt).not.toBeNull();
    expect(fresh.status).toBe("ok");
    expect(fresh.errorCode).toBeNull();
  });
```

**Test 6 — DeviceNotRegistered:**
```ts
  it("DNR error → UserDevice deleted (cascade deletes ticket)", async () => {
    const deviceId = await createUserDevice();
    await createTicket({ deviceId, ticketId: "tick-dnr" });
    await mockReceipts({
      "tick-dnr": {
        status: "error",
        message: "device not registered",
        details: { error: "DeviceNotRegistered" },
      },
    });
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(env);

    expect(await prisma.userDevice.count({ where: { id: deviceId } })).toBe(0);
    expect(await prisma.pushTicket.count()).toBe(0);  // CASCADE-deleted
  });
```

**Test 7 — InvalidCredentials:**
```ts
  it("InvalidCredentials → ticket marked error, UserDevice preserved", async () => {
    const deviceId = await createUserDevice();
    const tid = await createTicket({ deviceId, ticketId: "tick-creds" });
    await mockReceipts({
      "tick-creds": {
        status: "error",
        message: "creds bad",
        details: { error: "InvalidCredentials" },
      },
    });
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(env);

    const fresh = await prisma.pushTicket.findUniqueOrThrow({ where: { id: tid } });
    expect(fresh.polledAt).not.toBeNull();
    expect(fresh.status).toBe("error");
    expect(fresh.errorCode).toBe("InvalidCredentials");
    expect(await prisma.userDevice.count({ where: { id: deviceId } })).toBe(1);
  });
```

**Test 8 — other error (MessageRateExceeded):**
```ts
  it("MessageRateExceeded → ticket marked error, UserDevice preserved", async () => {
    const deviceId = await createUserDevice();
    const tid = await createTicket({ deviceId, ticketId: "tick-rate" });
    await mockReceipts({
      "tick-rate": {
        status: "error",
        message: "too many",
        details: { error: "MessageRateExceeded" },
      },
    });
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(env);

    const fresh = await prisma.pushTicket.findUniqueOrThrow({ where: { id: tid } });
    expect(fresh.status).toBe("error");
    expect(fresh.errorCode).toBe("MessageRateExceeded");
    expect(await prisma.userDevice.count({ where: { id: deviceId } })).toBe(1);
  });
```

**Test 9 — same-batch cascade guard (P2025 prevention):**
```ts
  it("same-batch cascade guard → no P2025 throw on later ticket for deleted device", async () => {
    const deviceId = await createUserDevice();
    // tick-A sentAt 3h ago (processed first by orderBy asc)
    await createTicket({
      deviceId, ticketId: "tick-A",
      sentAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
    });
    // tick-B sentAt 2h ago (processed second, but device already deleted)
    await createTicket({
      deviceId, ticketId: "tick-B",
      sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    });
    await mockReceipts({
      "tick-A": { status: "error", message: "x", details: { error: "DeviceNotRegistered" } },
      "tick-B": { status: "ok" },
    });
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");

    // LEAD assertion: guard prevents P2025.
    await expect(runPushReceipts(env)).resolves.not.toThrow();

    // Corroborating: device + both tickets gone via CASCADE.
    expect(await prisma.userDevice.count({ where: { id: deviceId } })).toBe(0);
    expect(await prisma.pushTicket.count()).toBe(0);
  });
```

**Test 10 — Expo SDK throws:**
```ts
  it("Expo getReceipts throws → cron does not throw, ticket unchanged", async () => {
    const deviceId = await createUserDevice();
    const tid = await createTicket({ deviceId, ticketId: "tick-net" });
    await mockReceipts({}, { throws: new Error("network down") });
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");

    await expect(runPushReceipts(env)).resolves.not.toThrow();

    const fresh = await prisma.pushTicket.findUniqueOrThrow({ where: { id: tid } });
    expect(fresh.polledAt).toBeNull();
    expect(fresh.status).toBeNull();
  });
```

- [ ] **Step 3: Run the file**

Run: `pnpm --filter @fina/api exec vitest run tests/cron.push-receipts.test.ts`
Expected: `Tests  10 passed (10)`.

If FAIL: read first error, fix one test, rerun. Common gotchas:
- `Prisma.Decimal` import — NOT needed here (no Decimal fields touched).
- `MockInstance` import from `vitest` — required for helper return type.
- `mockResolvedValue` on a spy created via `vi.spyOn` — verify the spy chain.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @fina/api exec tsc -p tsconfig.spec.json --noEmit 2>&1 | grep "cron.push-receipts" | head -5`
Expected: 0 lines.

- [ ] **Step 5: Commit**

Branch confirmation: `git branch --show-current` must show `worktree-plan-1q-push-receipts-cron-test`.

```bash
git add apps/api/tests/cron.push-receipts.test.ts
git commit -m "$(cat <<'EOF'
test(api): cron/push-receipts — 10 tests covering receipt polling state machine

Closes Plan 1P §7 follow-up #1. Covers DNR cascade, InvalidCredentials log,
other-error path, not-ready, ok, same-batch cascade guard (P2025 prevention),
and Expo SDK throw. Module-level Expo mock + per-test spy.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```
