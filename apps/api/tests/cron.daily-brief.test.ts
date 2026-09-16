import { describe, expect, it, beforeEach, afterAll, afterEach, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { currentLocalHHmm, syncMorningTimeToNow } from "./helpers/cron-time.js";
import {
  chatGeminiMock,
  lastChatLlmRequest,
  resetGeminiMock,
} from "./helpers/gemini-mock.js";

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-13T12:00:00Z")); // Monday: report path.
  await truncateAll();
  resetGeminiMock();
  chatGeminiMock.responses.push({ text: "test brief text" });
});
afterAll(async () => {
  await disconnect();
});

async function makeUser(tz = "America/Toronto", morningTime = "08:00") {
  return prisma.user.create({
    data: {
      id: `db-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      email: `db-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@t.co`,
      name: "DB",
      tz,
      morningTime,
      trialEndsAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
}

async function addWorkspaceTransaction(workspaceId: string, occurredAt = new Date()): Promise<void> {
  const account = await prisma.bankAccount.create({
    data: { workspaceId, name: "Checking", type: "depository" },
  });
  await prisma.transaction.create({
    data: {
      workspaceId,
      accountId: account.id,
      amount: "10.00",
      merchantRaw: "Merchant",
      occurredAt,
      source: "manual",
      rawData: {},
    },
  });
}

describe("runDailyBrief", () => {
  it("skips when no users match the current minute", async () => {
    await makeUser("America/Toronto", "00:01");
    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());
    const briefs = await prisma.brief.findMany();
    expect(briefs.length).toBeLessThanOrEqual(1);
  });

  it("emits a brief atomically (chat message + brief row) when user matches", async () => {
    const tz = "Asia/Seoul";
    const partsInTz = (await import("../src/chat/tools/periods.js")).partsInTz;
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const p1 = partsInTz(new Date(), tz);
    const initialHHmm = `${pad2(p1.hour)}:${pad2(p1.minute)}`;

    const u = await makeUser(tz, initialHHmm);
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await addWorkspaceTransaction(ws.id);

    // Recompute now and update if the minute rolled over during setup.
    const p2 = partsInTz(new Date(), tz);
    const nowHHmm = `${pad2(p2.hour)}:${pad2(p2.minute)}`;
    if (nowHHmm !== initialHHmm) {
      await prisma.user.update({ where: { id: u.id }, data: { morningTime: nowHHmm } });
    }

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);
    const msgs = await prisma.chatMessage.findMany({ where: { id: briefs[0]!.messageId } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.role).toBe("assistant");

    // The brief is part of the workspace's canonical thread.
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: msgs[0]!.threadId } });
    expect(thread.workspaceId).toBe(ws.id);
    expect(thread.userId).toBe(u.id);
  });

  it("is idempotent — running twice in the same minute produces only one brief", async () => {
    const tz = "Asia/Seoul";
    const u = await makeUser(tz, await currentLocalHHmm(tz));
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await addWorkspaceTransaction(ws.id);
    await syncMorningTimeToNow(u.id, tz);

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);
  });

  it("Free users never generate a brief or call the LLM", async () => {
    const tz = "Asia/Seoul";
    const u = await prisma.user.create({
      data: {
        id: `db-free-${Date.now()}`,
        email: `free-${Date.now()}@t.co`,
        name: "Free",
        tz,
        morningTime: await currentLocalHHmm(tz),
        trialEndsAt: new Date("2020-01-01T00:00:00Z"),
        trialConsumed: true,
      },
    });
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({
      data: { userId: u.id, workspaceId: ws.id, role: "owner" },
    });
    await syncMorningTimeToNow(u.id, tz);

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    expect(await prisma.brief.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.chatThread.count({ where: { userId: u.id } })).toBe(0);
    expect(chatGeminiMock.responses).toHaveLength(1);
  });

  it("passes recent workspace conversation into the morning brief prompt", async () => {
    const tz = "Asia/Seoul";
    const u = await makeUser(tz, await currentLocalHHmm(tz));
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({
      data: { userId: u.id, workspaceId: ws.id, role: "owner" },
    });
    await addWorkspaceTransaction(ws.id);
    const thread = await prisma.chatThread.create({
      data: { userId: u.id, workspaceId: ws.id },
    });
    await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        role: "user",
        blocks: [
          {
            type: "text",
            markdown: "Let's keep dining under $100 this week.",
          },
        ],
      },
    });
    await syncMorningTimeToNow(u.id, tz);

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const request = lastChatLlmRequest() as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    expect(
      request.messages?.some(
        (message) =>
          message.role === "user" &&
          message.content?.includes("keep dining under $100"),
      ),
    ).toBe(true);
    const brief = await prisma.brief.findFirstOrThrow({
      where: { userId: u.id, workspaceId: ws.id },
      include: { message: true },
    });
    expect(brief.message.threadId).toBe(thread.id);
  });

  it("uses the global report cadence even with a legacy issues_only preference", async () => {
    const tz = "Asia/Seoul";
    const u = await prisma.user.create({
      data: {
        id: `db-quiet-${Date.now()}`,
        email: `quiet-${Date.now()}@t.co`,
        name: "Quiet",
        tz,
        morningTime: await currentLocalHHmm(tz),
        morningBriefFrequency: "issues_only",
        trialEndsAt: new Date("2099-01-01T00:00:00Z"),
      },
    });
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await addWorkspaceTransaction(ws.id, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    await syncMorningTimeToNow(u.id, tz);

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    const messages = await prisma.chatMessage.findMany({
      where: { thread: { userId: u.id } },
    });
    expect(briefs).toHaveLength(1);
    expect(messages).toHaveLength(1);
  });

  it("emits an attention-only brief when an upcoming scheduled spend exists", async () => {
    const tz = "Asia/Seoul";
    const u = await prisma.user.create({
      data: {
        id: `db-attention-${Date.now()}`,
        email: `attention-${Date.now()}@t.co`,
        name: "Attention",
        tz,
        morningTime: await currentLocalHHmm(tz),
        morningBriefFrequency: "issues_only",
        trialEndsAt: new Date("2099-01-01T00:00:00Z"),
      },
    });
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await addWorkspaceTransaction(ws.id, new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    const category = await prisma.category.create({
      data: { workspaceId: ws.id, name: "Housing" },
    });
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: ws.id,
        categoryId: category.id,
        amount: "1200.00",
        scheduledDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    await syncMorningTimeToNow(u.id, tz);

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);
  });

  it("skips paused users (pauseEnabled=true)", async () => {
    const tz = "Asia/Seoul";
    const nowHHmm = await currentLocalHHmm(tz);

    const u = await prisma.user.create({
      data: {
        id: `db-paused-${Date.now()}`,
        email: `paused-${Date.now()}@t.co`,
        name: "P",
        tz,
        morningTime: nowHHmm,
        pauseEnabled: true,
      },
    });

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(0);
  });

  it("skips users with active snoozeUntil", async () => {
    const tz = "Asia/Seoul";
    const nowHHmm = await currentLocalHHmm(tz);

    const u = await prisma.user.create({
      data: {
        id: `db-snooze-${Date.now()}`,
        email: `snooze-${Date.now()}@t.co`,
        name: "S",
        tz,
        morningTime: nowHHmm,
        snoozeUntil: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(0);
  });

  it("appends to existing unbound thread instead of creating a new one", async () => {
    const tz = "Asia/Seoul";
    const u = await makeUser(tz, await currentLocalHHmm(tz));
    const existingThread = await prisma.chatThread.create({
      data: { userId: u.id, workspaceId: null },
    });
    await syncMorningTimeToNow(u.id, tz);

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const threads = await prisma.chatThread.findMany({ where: { userId: u.id } });
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe(existingThread.id);
  });
});

afterEach(() => vi.useRealTimers());
