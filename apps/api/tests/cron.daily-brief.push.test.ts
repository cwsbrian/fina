import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { currentLocalHHmm, syncMorningTimeToNow } from "./helpers/cron-time.js";
import { chatGeminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

// Mock expo-server-sdk — prototype method so vi.spyOn(Expo.prototype, ...) works.
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
  chatGeminiMock.responses.push({ text: "morning brief text" });
});
afterEach(() => { vi.restoreAllMocks(); });  // Vitest singleFork — prevent spy leakage across files.
afterAll(async () => { await disconnect(); });

describe("daily-brief push integration", () => {
  it("after brief tx commits, sendBriefPush fires for the user's device", async () => {
    const tz = "Asia/Seoul";
    const u = await prisma.user.create({
      data: { id: `bp-${Date.now()}`, email: `bp-${Date.now()}@t.co`, name: "BP",
              tz, morningTime: await currentLocalHHmm(tz) },
    });
    const ws = await prisma.workspace.create({ data: { name: "P" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await prisma.userDevice.create({
      data: { userId: u.id, expoPushToken: "ExponentPushToken[push1]", platform: "ios" },
    });
    await syncMorningTimeToNow(u.id, tz);

    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    // Brief is in DB (T1-2B path)
    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);
    // Push was sent (T6 contribution)
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it("push throw — brief still durable in DB", async () => {
    const tz = "Asia/Seoul";
    const u = await prisma.user.create({
      data: { id: `bpf-${Date.now()}`, email: `bpf-${Date.now()}@t.co`, name: "BPF",
              tz, morningTime: await currentLocalHHmm(tz) },
    });
    const ws = await prisma.workspace.create({ data: { name: "P" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await prisma.userDevice.create({
      data: { userId: u.id, expoPushToken: "ExponentPushToken[push2]", platform: "android" },
    });
    await syncMorningTimeToNow(u.id, tz);

    const { Expo } = await import("expo-server-sdk");
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockRejectedValueOnce(
      new Error("expo outage"),
    );

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);  // brief durably in DB even though push failed
  });

  it("user with zero devices — brief still emitted, no push attempt", async () => {
    const tz = "Asia/Seoul";
    const u = await prisma.user.create({
      data: { id: `nodev-${Date.now()}`, email: `nodev-${Date.now()}@t.co`, name: "ND",
              tz, morningTime: await currentLocalHHmm(tz) },
    });
    const ws = await prisma.workspace.create({ data: { name: "P" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await syncMorningTimeToNow(u.id, tz);

    const { Expo } = await import("expo-server-sdk");
    const sendSpy = vi.spyOn(Expo.prototype, "sendPushNotificationsAsync");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);
    expect(sendSpy).not.toHaveBeenCalled();  // 0 devices → no Expo call
  });
});
