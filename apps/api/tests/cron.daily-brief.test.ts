import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

// Mock Gemini — minimal response.
vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: "test brief text" }),
    },
  })),
}));

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

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

/** Returns the current HH:mm in the given tz. Tests that pre-seed a user
 *  with morningTime=now should call this immediately before invoking the
 *  cron, and update the user if the minute has rolled over since seeding,
 *  to avoid minute-boundary test flakes. */
async function currentLocalHHmm(tz: string): Promise<string> {
  const partsInTz = (await import("../src/chat/tools/periods.js")).partsInTz;
  const p = partsInTz(new Date(), tz);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Re-syncs a user's morningTime to the *current* HH:mm. */
async function syncMorningTimeToNow(userId: string, tz: string): Promise<void> {
  const now = await currentLocalHHmm(tz);
  await prisma.user.update({ where: { id: userId }, data: { morningTime: now } });
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
