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
