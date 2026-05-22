import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

// Realistic Gemini mock that returns brief-shaped text.
vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: vi.fn().mockResolvedValue({
        text: "좋은 아침이야 ☀️ 어제 Starbucks 한 건 분류 필요해. 오늘 시장 $100 잡혀있어. 잘 보내!",
      }),
    },
  })),
}));

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

describe("daily-brief E2E smoke", () => {
  it("seed user → fire cron → brief visible in chat thread (markdown)", async () => {
    const partsInTz = (await import("../src/chat/tools/periods.js")).partsInTz;
    const tz = "Asia/Seoul";
    const p = partsInTz(new Date(), tz);
    const pad2 = (n: number) => String(n).padStart(2, "0");
    const nowHHmm = `${pad2(p.hour)}:${pad2(p.minute)}`;

    const u = await prisma.user.create({
      data: { id: `e2e-${Date.now()}`, email: `e2e-${Date.now()}@t.co`, name: "E2E", tz, morningTime: nowHHmm },
    });
    const ws = await prisma.workspace.create({ data: { name: "Personal" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: ws.id, name: "Chequing", type: "depository" },
    });
    await prisma.transaction.create({
      data: {
        workspaceId: ws.id,
        accountId: acct.id,
        plaidTransactionId: "e2e-tx-1",
        amount: "10.00",
        merchantRaw: "Starbucks",
        occurredAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
        rawData: {},
      },
    });

    // Anti-flake: re-sync morningTime in case the minute has rolled over
    // during the multi-step seed above.
    const p2 = partsInTz(new Date(), tz);
    const nowHHmm2 = `${pad2(p2.hour)}:${pad2(p2.minute)}`;
    if (nowHHmm2 !== nowHHmm) {
      await prisma.user.update({ where: { id: u.id }, data: { morningTime: nowHHmm2 } });
    }

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(1);
    expect(briefs[0]!.type).toBeDefined();
    expect(briefs[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const msg = await prisma.chatMessage.findUniqueOrThrow({ where: { id: briefs[0]!.messageId } });
    expect(msg.role).toBe("assistant");
    const blocks = msg.blocks as unknown as Array<{ type: string; markdown?: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.markdown).toMatch(/Starbucks/);

    const thread = await prisma.chatThread.findUniqueOrThrow({ where: { id: msg.threadId } });
    expect(thread.userId).toBe(u.id);
    expect(thread.workspaceId).toBeNull();
  });
});
