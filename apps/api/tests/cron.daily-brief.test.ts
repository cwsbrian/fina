import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { currentLocalHHmm, syncMorningTimeToNow } from "./helpers/cron-time.js";
import { chatGeminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

beforeEach(async () => {
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

    // Unbound thread.
    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: msgs[0]!.threadId } });
    expect(thread.workspaceId).toBeNull();
    expect(thread.userId).toBe(u.id);
  });

  it("is idempotent — running twice in the same minute produces only one brief", async () => {
    const tz = "Asia/Seoul";
    const u = await makeUser(tz, await currentLocalHHmm(tz));
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await syncMorningTimeToNow(u.id, tz);

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);
  });

  it("skips quiet days for users who only want briefs when attention is needed", async () => {
    const tz = "Asia/Seoul";
    const u = await prisma.user.create({
      data: {
        id: `db-quiet-${Date.now()}`,
        email: `quiet-${Date.now()}@t.co`,
        name: "Quiet",
        tz,
        morningTime: await currentLocalHHmm(tz),
        morningBriefFrequency: "issues_only",
      },
    });
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await syncMorningTimeToNow(u.id, tz);

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    const messages = await prisma.chatMessage.findMany({
      where: { thread: { userId: u.id } },
    });
    expect(briefs).toHaveLength(0);
    expect(messages).toHaveLength(0);
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
      },
    });
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
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
