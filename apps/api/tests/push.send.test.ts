import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { MockInstance } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { makeUserWithDevices } from "./helpers/factories.js";

function firstPushMessage(spy: MockInstance): Record<string, unknown> {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const firstCall = calls[0]!;
  const chunk = firstCall[0] as Array<Record<string, unknown>>;
  expect(chunk.length).toBeGreaterThan(0);
  return chunk[0]!;
}

// Hoisted mock — expo-server-sdk must be mocked before push/send.ts loads.
// IMPORTANT: sendPushNotificationsAsync is a PROTOTYPE method (not a class
// field initialised with vi.fn()) so individual tests can vi.spyOn(
// Expo.prototype, "sendPushNotificationsAsync") and intercept calls.
// Class-field initialisers create per-instance properties which spyOn can't
// intercept via the prototype.
vi.mock("expo-server-sdk", () => {
  return {
    Expo: class {
      static isExpoPushToken(t: string) {
        return /^ExponentPushToken\[/.test(t);
      }
      chunkPushNotifications(messages: unknown[]) {
        // Single chunk in tests; matches real behavior for ≤100 messages.
        return [messages];
      }
      async sendPushNotificationsAsync(_messages: unknown[]): Promise<unknown[]> {
        return []; // default — tests override via vi.spyOn
      }
    },
  };
});

beforeEach(async () => {
  await truncateAll();
});
afterEach(() => {
  vi.restoreAllMocks();
}); // Vitest singleFork — prevent spy leakage across files.
afterAll(async () => {
  await disconnect();
});

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
    const u = await makeUserWithDevices([{ token: "ExponentPushToken[abc]", platform: "ios" }]);
    // Pre-stub the next .sendPushNotificationsAsync to return a single ok ticket
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "ticket_1" }]);
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);

    const { sendBriefPush } = await import("../src/push/send.js");
    const result = await sendBriefPush({} as never, u.id, "morning brief");
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("ok ticket → PushTicket row created with matching expoTicketId", async () => {
    const { Expo } = await import("expo-server-sdk");
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[ok-persists]", platform: "ios" },
    ]);
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "ticket_persist_1" }]);
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

  it("DeviceNotRegistered ticket → row deleted", async () => {
    const { Expo } = await import("expo-server-sdk");
    const u = await makeUserWithDevices([{ token: "ExponentPushToken[stale]", platform: "ios" }]);
    const sendSpy = vi
      .fn()
      .mockResolvedValueOnce([
        {
          status: "error",
          message: "device not registered",
          details: { error: "DeviceNotRegistered" },
        },
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
    const u = await makeUserWithDevices([{ token: "ExponentPushToken[rate]", platform: "ios" }]);
    const sendSpy = vi
      .fn()
      .mockResolvedValueOnce([
        { status: "error", message: "too many", details: { error: "MessageRateExceeded" } },
      ]);
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);

    const { sendBriefPush } = await import("../src/push/send.js");
    const result = await sendBriefPush({} as never, u.id, "x");
    expect(result.failed).toBe(1);
    const devices = await prisma.userDevice.findMany({ where: { userId: u.id } });
    expect(devices).toHaveLength(1); // not deleted — could work next time
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

describe("channel gate (notificationPrefs)", () => {
  it("sendBriefPush respects morningBrief: false (no Expo call)", async () => {
    const { Expo } = await import("expo-server-sdk");
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
    const u = await makeUserWithDevices(
      [{ token: "ExponentPushToken[gate-mb-off]", platform: "ios" }],
      { morningBrief: false },
    );

    const { sendBriefPush } = await import("../src/push/send.js");
    await sendBriefPush(testEnv(), u.id, "brief text");

    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("sendBriefPush with default prefs (null - Expo called once)", async () => {
    const { Expo } = await import("expo-server-sdk");
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[gate-mb-on]", platform: "ios" },
    ]);

    const { sendBriefPush } = await import("../src/push/send.js");
    await sendBriefPush(testEnv(), u.id, "brief text");

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("sendLargeChargePush respects largeCharges: false (no Expo call)", async () => {
    const { Expo } = await import("expo-server-sdk");
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
    const u = await makeUserWithDevices(
      [{ token: "ExponentPushToken[gate-lc-off]", platform: "ios" }],
      { largeCharges: false },
    );

    const { sendLargeChargePush } = await import("../src/push/send.js");
    await sendLargeChargePush(testEnv(), u.id, "Best Buy", "200.00", "Electronics");

    expect(spy).toHaveBeenCalledTimes(0);
  });

  it("sendLargeChargePush with default prefs (null - Expo called once)", async () => {
    const { Expo } = await import("expo-server-sdk");
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[gate-lc-on]", platform: "ios" },
    ]);

    const { sendLargeChargePush } = await import("../src/push/send.js");
    await sendLargeChargePush(testEnv(), u.id, "Best Buy", "200.00", "Electronics");

    expect(spy).toHaveBeenCalledTimes(1);
  });

  describe("sendBankReconnectPush", () => {
    it("respects bankReconnect: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-br-off]", platform: "ios" }],
        { bankReconnect: false },
      );

      const { sendBankReconnectPush } = await import("../src/push/send.js");
      await sendBankReconnectPush(testEnv(), u.id, "Chase");

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-br" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-br-on]", platform: "ios" },
      ]);

      const { sendBankReconnectPush } = await import("../src/push/send.js");
      await sendBankReconnectPush(testEnv(), u.id, "Chase");

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendTrialExpiringPush", () => {
    it("respects trialExpiring: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-te-off]", platform: "ios" }],
        { trialExpiring: false },
      );

      const { sendTrialExpiringPush } = await import("../src/push/send.js");
      await sendTrialExpiringPush(testEnv(), u.id, 3);

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-te" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-te-on]", platform: "ios" },
      ]);

      const { sendTrialExpiringPush } = await import("../src/push/send.js");
      await sendTrialExpiringPush(testEnv(), u.id, 3);

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendGoalMilestonePush", () => {
    it("respects goalMilestones: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-gm-off]", platform: "ios" }],
        { goalMilestones: false },
      );

      const { sendGoalMilestonePush } = await import("../src/push/send.js");
      await sendGoalMilestonePush(testEnv(), u.id, "Emergency Fund", 50);

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-gm" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-gm-on]", platform: "ios" },
      ]);

      const { sendGoalMilestonePush } = await import("../src/push/send.js");
      await sendGoalMilestonePush(testEnv(), u.id, "Emergency Fund", 50);

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendTransactionAddedPush", () => {
    it("respects transactionAdded: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-ta-off]", platform: "ios" }],
        { transactionAdded: false },
      );

      const { sendTransactionAddedPush } = await import("../src/push/send.js");
      await sendTransactionAddedPush(testEnv(), u.id, "Coffee", "5.50", "Food");

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-ta" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-ta-on]", platform: "ios" },
      ]);

      const { sendTransactionAddedPush } = await import("../src/push/send.js");
      await sendTransactionAddedPush(testEnv(), u.id, "Coffee", "5.50", "Food");

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendProductUpdatePush", () => {
    it("respects productUpdates: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-pu-off]", platform: "ios" }],
        { productUpdates: false },
      );

      const { sendProductUpdatePush } = await import("../src/push/send.js");
      await sendProductUpdatePush(testEnv(), u.id, "New feature", "Try it now");

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-pu" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-pu-on]", platform: "ios" },
      ]);

      const { sendProductUpdatePush } = await import("../src/push/send.js");
      await sendProductUpdatePush(testEnv(), u.id, "New feature", "Try it now");

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendWorkspaceInvitePush", () => {
    it("respects workspaceInvites: false (no Expo call)", async () => {
      const { Expo } = await import("expo-server-sdk");
      const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
      const u = await makeUserWithDevices(
        [{ token: "ExponentPushToken[gate-wi-off]", platform: "ios" }],
        { workspaceInvites: false },
      );

      const { sendWorkspaceInvitePush } = await import("../src/push/send.js");
      await sendWorkspaceInvitePush(testEnv(), u.id, "Alice", "Family");

      expect(spy).toHaveBeenCalledTimes(0);
    });

    it("default prefs → Expo called once", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-wi" }]);
      vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[gate-wi-on]", platform: "ios" },
      ]);

      const { sendWorkspaceInvitePush } = await import("../src/push/send.js");
      await sendWorkspaceInvitePush(testEnv(), u.id, "Alice", "Family");

      expect(sendSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe("sendTransactionAddedPush payload shape", () => {
  it("title='$merchant · $$amount', body='New transaction · category', dataType='transaction-added'", async () => {
    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-ta-1" }]);
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[ta-payload-1]", platform: "ios" },
    ]);

    const { sendTransactionAddedPush } = await import("../src/push/send.js");
    await sendTransactionAddedPush(testEnv(), u.id, "Starbucks", "5.50", "Coffee");

    expect(spy).toHaveBeenCalledTimes(1);
    const calls = spy.mock.calls;
    const firstCall = calls[0]!;
    const chunk = firstCall[0] as Array<Record<string, unknown>>;
    expect(chunk).toHaveLength(1);
    const msg = chunk[0]!;
    expect(msg).toEqual(
      expect.objectContaining({
        title: "Starbucks · $5.50",
        body: "New transaction · Coffee",
        data: { type: "transaction-added" },
      }),
    );
  });

  it("categoryName=null → body='New transaction' (no category suffix)", async () => {
    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-ta-2" }]);
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[ta-payload-2]", platform: "ios" },
    ]);

    const { sendTransactionAddedPush } = await import("../src/push/send.js");
    await sendTransactionAddedPush(testEnv(), u.id, "Anon Shop", "1.00", null);

    const calls = spy.mock.calls;
    const firstCall = calls[0]!;
    const chunk = firstCall[0] as Array<Record<string, unknown>>;
    const msg = chunk[0]!;
    expect(msg).toEqual(
      expect.objectContaining({
        title: "Anon Shop · $1.00",
        body: "New transaction",
      }),
    );
  });

  it("priority='high', sound='default' (regression guard against payload defaults change)", async () => {
    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-ta-3" }]);
    const spy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockImplementation(sendSpy);
    const u = await makeUserWithDevices([
      { token: "ExponentPushToken[ta-payload-3]", platform: "ios" },
    ]);

    const { sendTransactionAddedPush } = await import("../src/push/send.js");
    await sendTransactionAddedPush(testEnv(), u.id, "Test", "1.00", null);

    const calls = spy.mock.calls;
    const firstCall = calls[0]!;
    const chunk = firstCall[0] as Array<Record<string, unknown>>;
    const msg = chunk[0]!;
    expect(msg).toEqual(
      expect.objectContaining({
        priority: "high",
        sound: "default",
      }),
    );
  });
});

describe("payload-shape coverage for remaining wrappers", () => {
  describe("sendBriefPush", () => {
    it("title='Fina ☀️', dataType='daily-brief', body passthrough", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-br-1" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[brief-1]", platform: "ios" },
      ]);

      const { sendBriefPush } = await import("../src/push/send.js");
      await sendBriefPush(testEnv(), u.id, "Yesterday looked normal.");

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "Fina ☀️",
          body: "Yesterday looked normal.",
          data: { type: "daily-brief" },
        }),
      );
    });

    it("includes the brief chat thread id so notification taps can open the brief", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-br-route" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([
        { token: "ExponentPushToken[brief-route]", platform: "ios" },
      ]);

      const { sendBriefPush } = await import("../src/push/send.js");
      await sendBriefPush(testEnv(), u.id, "Open the brief.", { threadId: "thread_123" });

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          data: { type: "daily-brief", threadId: "thread_123" },
        }),
      );
    });
  });

  describe("sendBankReconnectPush", () => {
    it("title + body + dataType pinned", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-bk-1" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[brc-1]", platform: "ios" }]);

      const { sendBankReconnectPush } = await import("../src/push/send.js");
      await sendBankReconnectPush(testEnv(), u.id, "Chase");

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "Reconnect your bank",
          body: "Chase stopped syncing. Open Fina to reconnect.",
          data: { type: "bank-reconnect" },
        }),
      );
    });
  });

  describe("sendTrialExpiringPush", () => {
    it("daysLeft=1 → 'Your trial ends tomorrow'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-te-1" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[te-1]", platform: "ios" }]);

      const { sendTrialExpiringPush } = await import("../src/push/send.js");
      await sendTrialExpiringPush(testEnv(), u.id, 1);

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "Your trial ends tomorrow",
          data: { type: "trial-expiring" },
        }),
      );
    });

    it("daysLeft=5 → 'Your trial ends in 5 days'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-te-2" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[te-2]", platform: "ios" }]);

      const { sendTrialExpiringPush } = await import("../src/push/send.js");
      await sendTrialExpiringPush(testEnv(), u.id, 5);

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "Your trial ends in 5 days",
          data: { type: "trial-expiring" },
        }),
      );
    });
  });

  describe("sendGoalMilestonePush", () => {
    it("pct=100 → 'Goal complete: <title>'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-gm-1" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[gm-1]", platform: "ios" }]);

      const { sendGoalMilestonePush } = await import("../src/push/send.js");
      await sendGoalMilestonePush(testEnv(), u.id, "Vacation", 100);

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "Goal complete: Vacation",
          body: "Nice. Open Fina to see what's next.",
          data: { type: "goal-milestone" },
        }),
      );
    });

    it("pct<100 → '<pct>% there on <title>'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-gm-2" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[gm-2]", platform: "ios" }]);

      const { sendGoalMilestonePush } = await import("../src/push/send.js");
      await sendGoalMilestonePush(testEnv(), u.id, "Vacation", 50);

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "50% there on Vacation",
          body: "Keep going. Tap to see what's funding it.",
          data: { type: "goal-milestone" },
        }),
      );
    });
  });

  describe("sendLargeChargePush", () => {
    it("title='Unusual charge: $<amount>', body with category", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-lc-1" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[lc-1]", platform: "ios" }]);

      const { sendLargeChargePush } = await import("../src/push/send.js");
      await sendLargeChargePush(testEnv(), u.id, "Best Buy", "200.00", "Electronics");

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "Unusual charge: $200.00",
          body: "Best Buy for Electronics is well above your usual.",
          data: { type: "large-charge" },
        }),
      );
    });

    it("categoryName=null → body without ' for <category>'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-lc-2" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[lc-2]", platform: "ios" }]);

      const { sendLargeChargePush } = await import("../src/push/send.js");
      await sendLargeChargePush(testEnv(), u.id, "Anon", "100.00", null);

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "Unusual charge: $100.00",
          body: "Anon is well above your usual.",
        }),
      );
    });
  });

  describe("sendProductUpdatePush", () => {
    it("title/body passthrough, dataType='product-update'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-pu-1" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[pu-1]", platform: "ios" }]);

      const { sendProductUpdatePush } = await import("../src/push/send.js");
      await sendProductUpdatePush(testEnv(), u.id, "What's new in Fina", "Try the new chat!");

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "What's new in Fina",
          body: "Try the new chat!",
          data: { type: "product-update" },
        }),
      );
    });
  });

  describe("sendWorkspaceInvitePush", () => {
    it("title='Workspace invite', body templated, dataType='workspace-invite'", async () => {
      const { Expo } = await import("expo-server-sdk");
      const sendSpy = vi.fn().mockResolvedValueOnce([{ status: "ok", id: "t-wi-1" }]);
      const spy = vi
        .spyOn(Expo.prototype, "sendPushNotificationsAsync")
        .mockImplementation(sendSpy);
      const u = await makeUserWithDevices([{ token: "ExponentPushToken[wi-1]", platform: "ios" }]);

      const { sendWorkspaceInvitePush } = await import("../src/push/send.js");
      await sendWorkspaceInvitePush(testEnv(), u.id, "Alice", "Family Budget");

      expect(firstPushMessage(spy)).toEqual(
        expect.objectContaining({
          title: "Workspace invite",
          body: "Alice invited you to Family Budget.",
          data: { type: "workspace-invite" },
        }),
      );
    });
  });
});
