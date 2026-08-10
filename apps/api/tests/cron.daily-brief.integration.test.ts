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

// Stub generateBrief so categorize_confirm_card tests don't depend on
// the LLM. Returns a FRESH array each call — the cron mutates the
// returned blocks via .push(), so a shared mockResolvedValue array
// would leak state across tests.
vi.mock("../src/chat/brief.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/chat/brief.js")>();
  return {
    ...actual,
    generateBrief: vi.fn(async () => [{ type: "text", markdown: "hello" }]),
  };
});

// Silence push — sendBriefPush hits notification prefs + Expo path
// neither of which we want to exercise here.
vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendBriefPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

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
      merchantRaw: "Recent merchant",
      occurredAt,
      source: "manual",
      rawData: {},
    },
  });
}

describe("daily-brief integration", () => {
  it("zero-membership user — no workspace means no brief", async () => {
    const u = await makeUserMatchingNow();
    // No memberships.
    await syncMorningTimeToNow(u.id, "Asia/Seoul");  // anti-flake

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(briefs).toHaveLength(0);
  });

  it("workspace with no transactions — no brief", async () => {
    const u = await makeUserMatchingNow();
    const ws = await prisma.workspace.create({ data: { name: "Empty" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await syncMorningTimeToNow(u.id, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    expect(await prisma.brief.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.chatMessage.count({ where: { thread: { userId: u.id } } })).toBe(0);
  });

  it("workspace whose latest transaction is older than 30 days — no brief", async () => {
    const u = await makeUserMatchingNow();
    const ws = await prisma.workspace.create({ data: { name: "Inactive" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await addWorkspaceTransaction(ws.id, new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    await syncMorningTimeToNow(u.id, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    expect(await prisma.brief.count({ where: { userId: u.id } })).toBe(0);
    expect(await prisma.chatMessage.count({ where: { thread: { userId: u.id } } })).toBe(0);
  });

  it("post-run state is consistent — exactly 1 brief + 1 chatMessage per successful tick", async () => {
    const u = await makeUserMatchingNow();
    const ws = await prisma.workspace.create({ data: { name: "P" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await addWorkspaceTransaction(ws.id);
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

  it("after user replies, the next brief stays in the same workspace thread", async () => {
    const u = await makeUserMatchingNow();
    const ws = await prisma.workspace.create({ data: { name: "P" } });
    await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
    await addWorkspaceTransaction(ws.id);
    await syncMorningTimeToNow(u.id, "Asia/Seoul");  // anti-flake

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const briefs = await prisma.brief.findMany({ where: { userId: u.id } });
    const msg = await prisma.chatMessage.findUniqueOrThrow({ where: { id: briefs[0]!.messageId } });
    await prisma.chatMessage.create({
      data: {
        threadId: msg.threadId,
        role: "user",
        blocks: [{ type: "text", markdown: "Let's reduce dining this week." }],
      },
    });

    // Simulate "next day" by deleting today's brief — cron will re-fire.
    await prisma.brief.deleteMany({ where: { userId: u.id } });
    await syncMorningTimeToNow(u.id, "Asia/Seoul");  // anti-flake (minute may have rolled)

    await runDailyBrief(testEnv());

    const newBriefs = await prisma.brief.findMany({ where: { userId: u.id } });
    expect(newBriefs).toHaveLength(1);
    const newMsg = await prisma.chatMessage.findUniqueOrThrow({ where: { id: newBriefs[0]!.messageId } });
    const newThread = await prisma.chatThread.findUniqueOrThrow({ where: { id: newMsg.threadId } });
    expect(newThread.workspaceId).toBe(ws.id);
    expect(newThread.id).toBe(msg.threadId);
  });
});

// ---------- categorize_confirm_card block (Plan 1F) ----------

type CategorizeCardBlock = {
  type: "categorize_confirm_card";
  count: number;
  items: { txId: string; merchant: string; categoryName: string }[];
  moreCount: number;
};

let ccTxCounter = 0;
async function setupCardUser(opts?: {
  categorizationMode?: "auto" | "strict" | "flexible";
  tz?: string;
}): Promise<{ userId: string; wsId: string; accountId: string; catId: string }> {
  const tz = opts?.tz ?? "Asia/Seoul";
  const nowHHmm = await currentLocalHHmm(tz);
  const userId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@t.co`,
      name: "CC",
      tz,
      morningTime: nowHHmm,
      trialEndsAt: new Date("2099-01-01T00:00:00Z"),
      ...(opts?.categorizationMode ? { categorizationMode: opts.categorizationMode } : {}),
    },
  });
  const ws = await prisma.workspace.create({ data: { name: "CC-WS" } });
  await prisma.membership.create({ data: { userId, workspaceId: ws.id, role: "owner" } });
  const account = await prisma.bankAccount.create({
    data: { workspaceId: ws.id, name: "Checking", type: "depository" },
  });
  const cat = await prisma.category.create({
    data: { workspaceId: ws.id, name: `Dining-${Date.now()}-${Math.random().toString(36).slice(2, 5)}` },
  });
  return { userId, wsId: ws.id, accountId: account.id, catId: cat.id };
}

async function makeAllocNeedingConfirmation(args: {
  wsId: string;
  accountId: string;
  categoryId: string;
  merchant: string;
  occurredAt?: Date;
  txCreatedAt?: Date;
  dismissedUntil?: Date | null;
}): Promise<string> {
  ccTxCounter++;
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: args.wsId,
      accountId: args.accountId,
      plaidTransactionId: `pt_cc_${Date.now()}_${ccTxCounter}`,
      amount: 10,
      merchantRaw: args.merchant,
      occurredAt: args.occurredAt ?? new Date(),
      rawData: {},
      ...(args.txCreatedAt ? { createdAt: args.txCreatedAt } : {}),
    },
  });
  await prisma.transactionAllocation.create({
    data: {
      transactionId: tx.id,
      categoryId: args.categoryId,
      amount: "10",
      source: "ai",
      needsConfirmation: true,
      ...(args.dismissedUntil !== undefined ? { dismissedUntil: args.dismissedUntil } : {}),
    },
  });
  return tx.id;
}

async function getCategorizeCard(userId: string): Promise<CategorizeCardBlock | undefined> {
  // Fetch the LATEST brief — some tests seed a synthetic prior brief
  // to drive window-cap behavior, so the user can have >1 briefs.
  const brief = await prisma.brief.findFirstOrThrow({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
  const msg = await prisma.chatMessage.findUniqueOrThrow({
    where: { id: brief.messageId },
  });
  const blocks = msg.blocks as unknown as { type: string }[];
  return blocks.find((b) => b.type === "categorize_confirm_card") as
    | CategorizeCardBlock
    | undefined;
}

describe("daily-brief categorize_confirm_card block", () => {
  it("no needsConfirmation allocs → block is not emitted", async () => {
    const { userId, wsId } = await setupCardUser();
    await addWorkspaceTransaction(wsId);
    await syncMorningTimeToNow(userId, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const card = await getCategorizeCard(userId);
    expect(card).toBeUndefined();
  });

  it("3 needsConfirmation within window → count=3, items=3, moreCount=0", async () => {
    const { userId, wsId, accountId, catId } = await setupCardUser();
    for (let i = 0; i < 3; i++) {
      await makeAllocNeedingConfirmation({
        wsId, accountId, categoryId: catId, merchant: `M${i}`,
      });
    }
    await syncMorningTimeToNow(userId, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const card = await getCategorizeCard(userId);
    expect(card).toBeDefined();
    expect(card!.count).toBe(3);
    expect(card!.items).toHaveLength(3);
    expect(card!.moreCount).toBe(0);
  });

  it("7 needsConfirmation → count=7, items=5 (capped), moreCount=2", async () => {
    const { userId, wsId, accountId, catId } = await setupCardUser();
    for (let i = 0; i < 7; i++) {
      await makeAllocNeedingConfirmation({
        wsId, accountId, categoryId: catId, merchant: `M${i}`,
      });
    }
    await syncMorningTimeToNow(userId, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const card = await getCategorizeCard(userId);
    expect(card).toBeDefined();
    expect(card!.count).toBe(7);
    expect(card!.items).toHaveLength(5);
    expect(card!.moreCount).toBe(2);
  });

  it("dismissedUntil in the future (snoozed) → excluded from count", async () => {
    const { userId, wsId, accountId, catId } = await setupCardUser();
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    // 2 active + 1 snoozed = count should be 2.
    await makeAllocNeedingConfirmation({
      wsId, accountId, categoryId: catId, merchant: "Active1",
    });
    await makeAllocNeedingConfirmation({
      wsId, accountId, categoryId: catId, merchant: "Active2",
    });
    await makeAllocNeedingConfirmation({
      wsId, accountId, categoryId: catId, merchant: "Snoozed",
      dismissedUntil: future,
    });
    await syncMorningTimeToNow(userId, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const card = await getCategorizeCard(userId);
    expect(card).toBeDefined();
    expect(card!.count).toBe(2);
    expect(card!.items.find((i) => i.merchant === "Snoozed")).toBeUndefined();
  });

  it("Auto mode → block is not emitted even when needsConfirmation > 0", async () => {
    const { userId, wsId, accountId, catId } = await setupCardUser({
      categorizationMode: "auto",
    });
    await makeAllocNeedingConfirmation({
      wsId, accountId, categoryId: catId, merchant: "Auto",
    });
    await syncMorningTimeToNow(userId, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const card = await getCategorizeCard(userId);
    expect(card).toBeUndefined();
  });

  it("long pause: lastBriefAt 30d ago + 1 recent + 1 (20d ago) → window cap of 7d → count=1", async () => {
    const { userId, wsId, accountId, catId } = await setupCardUser();
    // Synthetic prior brief 30 days ago — older than the 7d cap.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const priorThread = await prisma.chatThread.create({
      data: { userId, workspaceId: wsId },
    });
    const priorMsg = await prisma.chatMessage.create({
      data: {
        threadId: priorThread.id,
        role: "assistant",
        blocks: [{ type: "text", markdown: "old" }] as unknown as object,
      },
    });
    await prisma.brief.create({
      data: {
        userId,
        workspaceId: wsId,
        type: "daily",
        date: "2026-04-25",
        messageId: priorMsg.id,
        createdAt: thirtyDaysAgo,
      },
    });

    // Recent alloc (5 days ago) — INSIDE 7d window.
    await makeAllocNeedingConfirmation({
      wsId, accountId, categoryId: catId, merchant: "Recent",
      txCreatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    // Stale alloc (20 days ago) — OUTSIDE 7d window.
    await makeAllocNeedingConfirmation({
      wsId, accountId, categoryId: catId, merchant: "Stale",
      txCreatedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    });
    await syncMorningTimeToNow(userId, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const card = await getCategorizeCard(userId);
    expect(card).toBeDefined();
    expect(card!.count).toBe(1);
    expect(card!.items[0]!.merchant).toBe("Recent");
  });

  it("excludes uncategorized allocations (categoryId IS NULL) from the card", async () => {
    const { userId, wsId, accountId } = await setupCardUser();
    // Uncategorized alloc — categoryId=null + needsConfirmation=true.
    // Semantically NOT a "confirm" candidate; should be filtered out.
    ccTxCounter++;
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId,
        plaidTransactionId: `pt_cc_${Date.now()}_${ccTxCounter}`,
        amount: 5,
        merchantRaw: "UNKNOWN MERCH",
        merchantNormalized: "unknown",
        occurredAt: new Date(),
        rawData: {},
      },
    });
    await prisma.transactionAllocation.create({
      data: {
        transactionId: tx.id,
        categoryId: null,
        amount: "5",
        needsConfirmation: true,
      },
    });
    await syncMorningTimeToNow(userId, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    // No categorized rows exist; total count is 0, so block must not emit.
    const card = await getCategorizeCard(userId);
    expect(card).toBeUndefined();
  });

  it("normal: lastBriefAt 2d ago + 1 (1d ago) + 1 (5d ago) → window from 2d ago → count=1", async () => {
    const { userId, wsId, accountId, catId } = await setupCardUser();
    // Synthetic prior brief 2 days ago — INSIDE the 7d cap so it wins.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const priorThread = await prisma.chatThread.create({
      data: { userId, workspaceId: wsId },
    });
    const priorMsg = await prisma.chatMessage.create({
      data: {
        threadId: priorThread.id,
        role: "assistant",
        blocks: [{ type: "text", markdown: "old" }] as unknown as object,
      },
    });
    await prisma.brief.create({
      data: {
        userId,
        workspaceId: wsId,
        type: "daily",
        date: "2026-05-23",
        messageId: priorMsg.id,
        createdAt: twoDaysAgo,
      },
    });

    // 1 day ago — INSIDE the 2d window.
    await makeAllocNeedingConfirmation({
      wsId, accountId, categoryId: catId, merchant: "Inside",
      txCreatedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
    });
    // 5 days ago — OUTSIDE the 2d window.
    await makeAllocNeedingConfirmation({
      wsId, accountId, categoryId: catId, merchant: "Outside",
      txCreatedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    });
    await syncMorningTimeToNow(userId, "Asia/Seoul");

    const { runDailyBrief } = await import("../src/cron/jobs/daily-brief.js");
    await runDailyBrief(testEnv());

    const card = await getCategorizeCard(userId);
    expect(card).toBeDefined();
    expect(card!.count).toBe(1);
    expect(card!.items[0]!.merchant).toBe("Inside");
  });
});
