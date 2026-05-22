import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";

// Hoisted mock — expo-server-sdk must be mocked before push/send.ts loads.
// IMPORTANT: sendPushNotificationsAsync is a PROTOTYPE method (not a class
// field initialised with vi.fn()) so individual tests can vi.spyOn(
// Expo.prototype, "sendPushNotificationsAsync") and intercept calls.
// Class-field initialisers create per-instance properties which spyOn can't
// intercept via the prototype.
vi.mock("expo-server-sdk", () => {
  return {
    Expo: class {
      static isExpoPushToken(t: string) { return /^ExponentPushToken\[/.test(t); }
      chunkPushNotifications(messages: unknown[]) {
        // Single chunk in tests; matches real behavior for ≤100 messages.
        return [messages];
      }
      async sendPushNotificationsAsync(_messages: unknown[]): Promise<unknown[]> {
        return [];  // default — tests override via vi.spyOn
      }
    },
  };
});

beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.restoreAllMocks(); });  // Vitest singleFork — prevent spy leakage across files.
afterAll(async () => { await disconnect(); });

async function makeUserWithDevices(tokens: Array<{ token: string; platform: "ios" | "android" }>) {
  const u = await prisma.user.create({
    data: { id: `push-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
            email: `push-${Date.now()}@t.co`, name: "P" },
  });
  for (const t of tokens) {
    await prisma.userDevice.create({
      data: { userId: u.id, expoPushToken: t.token, platform: t.platform },
    });
  }
  return u;
}

describe("sendBriefPush", () => {
  it("no devices — no-op + logs zero count", async () => {
    const u = await makeUserWithDevices([]);
    const { sendBriefPush } = await import("../src/push/send.js");
    const result = await sendBriefPush({} as never, u.id, "hello brief text");
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("one device — calls Expo once, returns sent=1", async () => {
    const { Expo } = await import("expo-server-sdk");
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[abc]", platform: "ios" },
    ]);
    // Pre-stub the next .sendPushNotificationsAsync to return a single ok ticket
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "ticket_1" }]);
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);

    const { sendBriefPush } = await import("../src/push/send.js");
    const result = await sendBriefPush({} as never, u.id, "morning brief");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("DeviceNotRegistered ticket → row deleted", async () => {
    const { Expo } = await import("expo-server-sdk");
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[stale]", platform: "ios" },
    ]);
    const sendSpy = vi.fn().mockResolvedValueOnce([
      { status: "error", message: "device not registered", details: { error: "DeviceNotRegistered" } },
    ]);
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);

    const { sendBriefPush } = await import("../src/push/send.js");
    const result = await sendBriefPush({} as never, u.id, "x");
    expect(result.failed).toBe(1);
    const devices = await prisma.userDevice.findMany({ where: { userId: u.id } });
    expect(devices).toHaveLength(0);
  });

  it("non-DeviceNotRegistered error → row preserved, warn logged", async () => {
    const { Expo } = await import("expo-server-sdk");
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[rate]", platform: "ios" },
    ]);
    const sendSpy = vi.fn().mockResolvedValueOnce([
      { status: "error", message: "too many", details: { error: "MessageRateExceeded" } },
    ]);
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);

    const { sendBriefPush } = await import("../src/push/send.js");
    const result = await sendBriefPush({} as never, u.id, "x");
    expect(result.failed).toBe(1);
    const devices = await prisma.userDevice.findMany({ where: { userId: u.id } });
    expect(devices).toHaveLength(1);  // not deleted — could work next time
  });

  it("filters out malformed tokens (Expo.isExpoPushToken false)", async () => {
    const u = await makeUserWithDevices([
      { token: "not-an-expo-token", platform: "ios" },
      { token: "ExponentPushToken[good]", platform: "ios" },
    ]);
    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t1" }]);
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);

    const { sendBriefPush } = await import("../src/push/send.js");
    const result = await sendBriefPush({} as never, u.id, "x");
    // Malformed token gets filtered before send; only 1 ticket expected.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
  });
});
