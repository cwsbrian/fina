import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { runDailyBrief, determineBriefType } from "../src/cron/jobs/daily-brief.js";
import { briefTransactionRange } from "../src/chat/brief-context.js";

const mocks = vi.hoisted(() => ({
  generate: vi.fn(async () => [{ type: "text", markdown: "Weekly/monthly report" }]),
  send: vi.fn(async (_messages: unknown[]) => [{ status: "ok", id: `ticket-${Math.random()}` }]),
}));
vi.mock("../src/chat/brief.js", async (original) => ({
  ...await original<typeof import("../src/chat/brief.js")>(), generateBrief: mocks.generate,
}));
vi.mock("expo-server-sdk", () => ({ Expo: class {
  static isExpoPushToken() { return true; }
  chunkPushNotifications(messages: unknown[]) { return [messages]; }
  sendPushNotificationsAsync = mocks.send;
} }));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-16T15:00:00Z")); // Wednesday, 08:00 Vancouver
  vi.clearAllMocks();
  await truncateAll();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(disconnect);

async function setup(paid = false) {
  const user = await prisma.user.create({ data: {
    id: "morning-user", email: "morning@test.local", tz: "America/Vancouver", morningTime: "08:00",
    trialEndsAt: new Date(paid ? "2099-01-01" : "2020-01-01"), trialConsumed: !paid,
    morningBriefFrequency: "issues_only",
  } });
  const ws = await prisma.workspace.create({ data: { name: "Personal", currency: "CAD" } });
  await prisma.membership.create({ data: { userId: user.id, workspaceId: ws.id, role: "owner" } });
  const acct = await prisma.bankAccount.create({ data: { workspaceId: ws.id, name: "Checking", type: "depository" } });
  await prisma.userDevice.create({ data: { userId: user.id, expoPushToken: "ExponentPushToken[test]", platform: "ios" } });
  const seed = (amount: number, occurredAt: string, extra: object = {}) => prisma.transaction.create({ data: {
    workspaceId: ws.id, accountId: acct.id, merchantRaw: "Merchant", amount,
    occurredAt: new Date(occurredAt), source: "manual", rawData: {}, ...extra,
  } });
  return { user, ws, seed };
}

it.each([false, true])("daily is DB-only, opens Home and is deduplicated (paid=%s)", async (paid) => {
  const { seed, user } = await setup(paid);
  await seed(42.80, "2026-09-15T20:00:00Z");
  await seed(100, "2026-09-16T07:00:00Z"); // Today, excluded from yesterday
  await seed(50, "2026-09-15T06:59:59Z"); // Before yesterday
  await seed(70, "2026-09-15T20:00:00Z", { pending: true });
  await seed(80, "2026-09-15T20:00:00Z", { removedAt: new Date() });
  await seed(90, "2026-09-15T20:00:00Z", { billingGraceHiddenAt: new Date() });
  await seed(99, "2026-09-15T20:00:00Z", { budgetImpact: "excluded" });
  await seed(-10, "2026-09-15T20:00:00Z", { budgetImpact: "refund" });
  await seed(-20, "2026-09-15T20:00:00Z", { budgetImpact: "income" });
  await Promise.all([runDailyBrief(testEnv()), runDailyBrief(testEnv())]);
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(await prisma.llmCallLog.count({ where: { userId: user.id } })).toBe(0);
  expect(await prisma.chatThread.count()).toBe(0);
  expect(await prisma.chatMessage.count()).toBe(0);
  expect(await prisma.brief.count()).toBe(0);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.send.mock.calls[0]?.[0]).toEqual([expect.objectContaining({
    body: "Personal: Yesterday you spent $42.80 · 1 transaction.", data: { type: "daily-spending" },
  })]);
});

it.each(["2026-09-14", "2026-10-01", "2026-06-01"])("report day %s appends one report to the existing thread", async (date) => {
  vi.setSystemTime(new Date(`${date}T15:00:00Z`));
  const { user, ws, seed } = await setup(true);
  await seed(10, new Date(Date.now() - 86400000).toISOString());
  const thread = await prisma.chatThread.create({ data: { userId: user.id, workspaceId: ws.id } });
  await runDailyBrief(testEnv());
  await runDailyBrief(testEnv());
  expect(mocks.generate).toHaveBeenCalledTimes(1);
  expect(await prisma.brief.findFirst()).toMatchObject({ type: date.endsWith("01") ? "monthly" : "weekly" });
  expect(await prisma.chatMessage.findFirst()).toMatchObject({ threadId: thread.id });
  expect(mocks.send.mock.calls[0]?.[0]).toEqual([expect.objectContaining({ data: { type: "daily-brief", threadId: thread.id } })]);
});

it("Free gets only the simple summary even on a monthly report day", async () => {
  vi.setSystemTime(new Date("2026-10-01T15:00:00Z"));
  const { seed } = await setup();
  await seed(10, "2026-09-30T20:00:00Z");
  await runDailyBrief(testEnv());
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(await prisma.chatThread.count()).toBe(0);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it.each(["paused", "snoozed", "disabled"])("respects %s daily notifications", async (setting) => {
  const { seed, user } = await setup();
  await seed(10, "2026-09-15T20:00:00Z");
  await prisma.user.update({ where: { id: user.id }, data: setting === "paused" ? { pauseEnabled: true }
    : setting === "snoozed" ? { snoozeUntil: new Date("2026-10-01") } : { notificationPrefs: { morningBrief: false } } });
  await runDailyBrief(testEnv());
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
});

it("daily delivery failure never falls back to LLM", async () => {
  const { seed } = await setup(true);
  await seed(10, "2026-09-15T20:00:00Z");
  mocks.send.mockRejectedValueOnce(new Error("Expo unavailable"));
  await runDailyBrief(testEnv());
  expect(mocks.generate).not.toHaveBeenCalled();
  expect(await prisma.chatMessage.count()).toBe(0);
});

it("uses complete local calendar periods across DST and leap months", () => {
  expect(briefTransactionRange("daily", new Date("2026-03-09T15:00:00Z"), "America/Vancouver")).toEqual({
    gte: new Date("2026-03-08T08:00:00Z"), lt: new Date("2026-03-09T07:00:00Z"),
  });
  expect(briefTransactionRange("monthly", new Date("2024-03-01T16:00:00Z"), "America/Vancouver")).toEqual({
    gte: new Date("2024-02-01T08:00:00Z"), lt: new Date("2024-03-01T08:00:00Z"),
  });
  expect(determineBriefType("2026-06-01")).toBe("monthly");
});
