import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { currentLocalHHmm, syncMorningTimeToNow } from "./helpers/cron-time.js";
import { chatGeminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

vi.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken(t: string) { return /^ExponentPushToken\[/.test(t); }
    chunkPushNotifications(messages: unknown[]) { return [messages]; }
    async sendPushNotificationsAsync(_messages: unknown[]) {
      return [{ status: "ok", id: "t1" }];
    }
  },
}));

beforeEach(async () => {
  await truncateAll();
  resetGeminiMock();
  chatGeminiMock.responses.push({
    text: "좋은 아침이야. 어제 Starbucks 한 건 분류 필요해. 오늘 시장 $100 잡혀있어. 잘 보내!",
  });
});
afterEach(() => { vi.restoreAllMocks(); });  // Vitest singleFork — prevent spy leakage across files.
afterAll(async () => { await disconnect(); });

describe("E2E: sign-up → register device → cron fires → push dispatched", () => {
  it("full chain", async () => {
    const app = await buildApp(testEnv());

    // 1) Sign up.
    const { cookie, userId } = await signUpAndGetCookie(app, { email: "e2e-push@t.co" });
    const ws = await prisma.workspace.create({ data: { name: "P" } });
    await prisma.membership.create({ data: { userId, workspaceId: ws.id, role: "owner" } });

    // 2) Register device via POST /devices.
    const registerRes = await app.inject({
      method: "POST",
      url: "/devices",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ expoPushToken: "ExponentPushToken[e2e]", platform: "ios" }),
    });
    expect(registerRes.statusCode).toBe(204);

    // 3) Set morningTime to current minute in user's tz so cron picks them up.
    const tz = "Asia/Seoul";
    const nowHHmm = await currentLocalHHmm(tz);
    await prisma.user.update({ where: { id: userId }, data: { tz, morningTime: nowHHmm } });

    // Re-sync right before cron to handle minute rollover.
    await syncMorningTimeToNow(userId, tz);

    // 4) Fire cron.
    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");
    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    // 5) Verify brief in DB + push dispatched.
    const briefs = await prisma.brief.findMany({ where: { userId } });
    expect(briefs).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sendArg = sendSpy.mock.calls[0]?.[0] as Array<{ body: string; to: string }>;
    expect(sendArg[0]?.to).toBe("ExponentPushToken[e2e]");
    expect(sendArg[0]?.body).toMatch(/Starbucks/);

    await app.close();
  });
});
