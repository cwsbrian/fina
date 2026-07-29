import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { buildBriefContext } from "../src/chat/brief-context.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const mocks = vi.hoisted(() => ({
  generateBrief: vi.fn(
    async (_env: unknown, _context: unknown, _recent: unknown, _briefType: unknown) => [
      { type: "text", markdown: "brief" },
    ],
  ),
  sendBriefPush: vi.fn(async () => ({ sent: 1, failed: 0 })),
}));

vi.mock("../src/chat/brief.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat/brief.js")>();
  return { ...actual, generateBrief: mocks.generateBrief };
});

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return { ...actual, sendBriefPush: mocks.sendBriefPush };
});

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-14T12:00:00Z")); // Tuesday, 21:00 in Seoul.
  vi.clearAllMocks();
  await truncateAll();
});

afterEach(() => vi.useRealTimers());
afterAll(async () => disconnect());

async function setupRisk(previousDate = "2026-07-13") {
  const user = await prisma.user.create({
    data: {
      id: `dedupe-${Math.random()}`,
      email: `dedupe-${Math.random()}@t.co`,
      tz: "Asia/Seoul",
      morningTime: "21:00",
      morningBriefFrequency: "issues_only",
      trialEndsAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
  const workspace = await prisma.workspace.create({ data: { name: "Personal", currency: "CAD" } });
  await prisma.membership.create({
    data: { userId: user.id, workspaceId: workspace.id, role: "owner" },
  });
  const category = await prisma.category.create({
    data: { workspaceId: workspace.id, name: "Shopping" },
  });
  const account = await prisma.bankAccount.create({
    data: {
      workspaceId: workspace.id,
      name: "Chequing",
      type: "depository",
      currency: "CAD",
    },
  });
  await prisma.budgetPlan.create({
    data: {
      workspaceId: workspace.id,
      periodStart: new Date("2026-07-01T12:00:00Z"),
      totalAmount: "1000.00",
      categoryAllocations: [{ categoryId: category.id, amount: 500 }],
    },
  });
  await addSpend(workspace.id, account.id, category.id, "1300.00", "2026-07-02T12:00:00Z");

  const { snapshotForecastState } = await import("../src/cron/jobs/daily-brief.js");
  const context = await buildBriefContext(user.id, "daily");
  const previousState = snapshotForecastState(context);
  const thread = await prisma.chatThread.create({
    data: { userId: user.id, workspaceId: workspace.id },
  });
  const message = await prisma.chatMessage.create({
    data: { threadId: thread.id, role: "assistant", blocks: [{ type: "text", markdown: "old" }] },
  });
  await prisma.brief.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      type: "daily",
      date: previousDate,
      messageId: message.id,
      forecastState: previousState,
    },
  });
  return { user, workspace, category, account };
}

async function addSpend(
  workspaceId: string,
  accountId: string,
  categoryId: string,
  amount: string,
  occurredAt: string,
) {
  const transaction = await prisma.transaction.create({
    data: {
      workspaceId,
      accountId,
      amount,
      merchantRaw: "Merchant",
      occurredAt: new Date(occurredAt),
      source: "manual",
      pending: false,
      rawData: {},
    },
  });
  await prisma.transactionAllocation.create({
    data: { transactionId: transaction.id, categoryId, amount },
  });
}

describe("Daily brief forecast dedupe flow", () => {
  it("skips an issues-only brief when the unchanged forecast is the only issue", async () => {
    const { user } = await setupRisk();
    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");

    await runDailyBrief(testEnv());

    expect(await prisma.brief.count({ where: { userId: user.id } })).toBe(1);
    expect(mocks.generateBrief).not.toHaveBeenCalled();
    expect(mocks.sendBriefPush).not.toHaveBeenCalled();
  });

  it("delivers a new small transaction but suppresses the unchanged forecast", async () => {
    const { user, workspace, category, account } = await setupRisk();
    await addSpend(workspace.id, account.id, category.id, "5.00", "2026-07-14T11:00:00Z");
    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");

    await runDailyBrief(testEnv());

    expect(await prisma.brief.count({ where: { userId: user.id } })).toBe(2);
    const context = mocks.generateBrief.mock.calls[0]?.[1] as Awaited<
      ReturnType<typeof buildBriefContext>
    >;
    expect(context.workspaces[0]?.forecast.mention).toBe(false);
    const latest = await prisma.brief.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { date: "desc" },
    });
    expect(latest.forecastState).toBeNull();
  });

  it("re-includes and stores the forecast after a meaningful amount change", async () => {
    const { user, workspace, category, account } = await setupRisk();
    await addSpend(workspace.id, account.id, category.id, "200.00", "2026-07-14T11:00:00Z");
    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");

    await runDailyBrief(testEnv());

    const context = mocks.generateBrief.mock.calls[0]?.[1] as Awaited<
      ReturnType<typeof buildBriefContext>
    >;
    expect(context.workspaces[0]?.forecast.mention).toBe(true);
    const latest = await prisma.brief.findFirstOrThrow({
      where: { userId: user.id },
      orderBy: { date: "desc" },
    });
    expect(latest.forecastState).not.toBeNull();
    expect(mocks.sendBriefPush).toHaveBeenCalledTimes(1);
  });

  it("does not apply Daily dedupe to a Weekly brief", async () => {
    vi.setSystemTime(new Date("2026-07-13T12:00:00Z")); // Monday in Seoul.
    await setupRisk("2026-07-12");
    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");

    await runDailyBrief(testEnv());

    const context = mocks.generateBrief.mock.calls[0]?.[1] as Awaited<
      ReturnType<typeof buildBriefContext>
    >;
    expect(context.briefType).toBe("weekly");
    expect(context.workspaces[0]?.forecast.mention).toBe(true);
  });
});
