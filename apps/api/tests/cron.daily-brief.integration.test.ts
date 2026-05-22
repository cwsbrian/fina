import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: vi.fn().mockResolvedValue({ text: "integration brief" }),
    },
  })),
}));

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

async function currentLocalHHmm(tz: string): Promise<string> {
  const partsInTz = (await import("../src/chat/tools/periods.js")).partsInTz;
  const p = partsInTz(new Date(), tz);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

async function syncMorningTimeToNow(userId: string, tz: string): Promise<void> {
  const now = await currentLocalHHmm(tz);
  await prisma.user.update({ where: { id: userId }, data: { morningTime: now } });
}

async function makeUserMatchingNow(tz = "Asia/Seoul") {
  const nowHHmm = await currentLocalHHmm(tz);
  return prisma.user.create({
    data: {
      id: `int-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      email: `int-${Date.now()}@t.co`,
      name: "Int",
      tz,
      morningTime: nowHHmm,
    },
  });
}

describe("daily-brief integration", () => {
  it("zero-membership user — brief is still generated (encouragement-only)", async () => {
    const u = await makeUserMatchingNow();
    // No memberships.
    await syncMorningTimeToNow(u.id, "Asia/Seoul");  // anti-flake

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);
    const msgs = await prisma.chatMessage.findMany({ where: { id: briefs[0]!.messageId } });
    expect(msgs).toHaveLength(1);
  });

  it("post-run state is consistent — exactly 1 brief + 1 chatMessage per successful tick", async () => {
    const u = await makeUserMatchingNow();
    const ws = await prisma.workspace.create({ data: { name: "P" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await syncMorningTimeToNow(u.id, "Asia/Seoul");  // anti-flake

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);
    const allMsgsInUserThreads = await prisma.chatMessage.findMany({
      where: { thread: { userId: u.id } },
    });
    expect(allMsgsInUserThreads).toHaveLength(1);
    expect(allMsgsInUserThreads[0]!.id).toBe(briefs[0]!.messageId);
  });

  it("Plan 2-chat-user-scope lazy-binding — after user replies, next day's brief creates a new unbound thread", async () => {
    const u = await makeUserMatchingNow();
    const ws = await prisma.workspace.create({ data: { name: "P" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await syncMorningTimeToNow(u.id, "Asia/Seoul");  // anti-flake

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    // User replies — this binds the thread.
    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    const msg = await prisma.chatMessage.findUniqueOrThrow({ where: { id: briefs[0]!.messageId } });
    await prisma.chatThread.update({
      where: { id: msg.threadId },
      data: { workspaceId: ws.id },  // lazy bind on first reply
    });

    // Simulate "next day" by deleting today's brief — cron will re-fire.
    await prisma.brief.deleteMany({ where: { userId: u.id } });
    await syncMorningTimeToNow(u.id, "Asia/Seoul");  // anti-flake (minute may have rolled)

    await runDailyBrief(testEnv());

    const newBriefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(newBriefs).toHaveLength(1);
    const newMsg = await prisma.chatMessage.findUniqueOrThrow({ where: { id: newBriefs[0]!.messageId } });
    const newThread = await prisma.chatThread.findUniqueOrThrow({ where: { id: newMsg.threadId } });
    expect(newThread.workspaceId).toBeNull();  // new unbound thread
    expect(newThread.id).not.toBe(msg.threadId);
  });
});
