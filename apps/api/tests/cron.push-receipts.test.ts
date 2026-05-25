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
    // Cast: real SDK return type is Record<string, ExpoPushReceipt>; our
    // test fixtures intentionally pass shape-compatible literals (status/
    // message/details) typed as `unknown` to avoid importing SDK types.
    spy.mockResolvedValue(map as never);
  }
  return spy;
}

describe("runPushReceipts", () => {
  it("no tickets → no Expo call", async () => {
    const spy = await mockReceipts({});
    const { runPushReceipts } = await import("../src/cron/jobs/push-receipts.js");
    await runPushReceipts(env);
    expect(spy).toHaveBeenCalledTimes(0);
  });

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
});
