import { prisma } from "../../db.js";
import { logInfo, logError } from "../../logger.js";
import type { Env } from "../../env.js";
import { partsInTz, resolveTz } from "../../chat/tools/periods.js";
import { buildBriefContext, briefTransactionRange, type BriefType } from "../../chat/brief-context.js";
import { generateBrief, briefBlocksToText } from "../../chat/brief.js";
import { llmPromptCacheKey } from "../../llm/provider.js";
import type { PresentationBlock } from "../../chat/blocks.js";
import { sendBriefPush } from "../../push/send.js";
import { markdownToPlainPreview } from "../../push/markdown-preview.js";
import { effectiveTier } from "../../auth/tier.js";
import { isPaidFeatureTier } from "@fina/shared";
import { threadsService } from "../../chat/threads.js";
import { selectHistoryWindow } from "../../chat/history-window.js";
import { toLlmHistory } from "../../chat/turn.js";

const CRON_NAME = "daily-brief";
export const MORNING_BRIEF_ACTIVITY_WINDOW_DAYS = 30;
const MORNING_BRIEF_ACTIVITY_WINDOW_MS =
  MORNING_BRIEF_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Daily spending pushes are available to everyone, without LLM or chat writes.
 * Paid users receive a weekly/monthly report in their thread on report days. */
export async function runDailyBrief(env: Env): Promise<void> {
  const candidates = await prisma.user.findMany({
    where: {
      pauseEnabled: false,
      OR: [{ snoozeUntil: null }, { snoozeUntil: { lt: new Date() } }],
    },
    select: { id: true, morningTime: true, tz: true },
  });
  if (candidates.length === 0) return;

  type Enriched = {
    id: string;
    morningTime: string;
    tz: string;
    localHHmm: string;
    localDate: string;
  };
  const enriched: Enriched[] = candidates.map((u) => {
    const tz = resolveTz(u.tz);
    const p = partsInTz(new Date(), tz);
    return {
      id: u.id,
      morningTime: u.morningTime,
      tz,
      localHHmm: `${pad2(p.hour)}:${pad2(p.minute)}`,
      localDate: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    };
  });
  const timeMatched = enriched.filter((u) => u.localHHmm === u.morningTime);
  if (timeMatched.length === 0) return;

  for (const u of timeMatched) {
    try {
      const tier = await effectiveTier(u.id);
      const briefType = isPaidFeatureTier(tier.tier) ? determineBriefType(u.localDate) : "daily";
      const memberships = await prisma.membership.findMany({
        where: { userId: u.id },
        select: { workspaceId: true },
      });
      for (const membership of memberships) {
        try {
          await emitWorkspaceBrief(env, u, membership.workspaceId, briefType);
        } catch (err) {
          logError(
            { cron: CRON_NAME, userId: u.id, workspaceId: membership.workspaceId, err },
            "workspace brief generation failed",
          );
        }
      }
    } catch (err) {
      logError({ cron: CRON_NAME, userId: u.id, err }, "brief generation failed");
    }
  }
}

type BriefUser = {
  id: string;
  morningTime: string;
  tz: string;
  localHHmm: string;
  localDate: string;
};

async function emitWorkspaceBrief(
  env: Env,
  u: BriefUser,
  workspaceId: string,
  briefType: BriefType,
): Promise<void> {
  const exists = await prisma.brief.findFirst({
    where: { userId: u.id, workspaceId, date: u.localDate },
    select: { id: true },
  });
  if (exists) return;

  const now = new Date();
  const recentTransaction = await prisma.transaction.findFirst({
    where: {
      workspaceId,
      removedAt: null,
      billingGraceHiddenAt: null,
      occurredAt: {
        gte: new Date(now.getTime() - MORNING_BRIEF_ACTIVITY_WINDOW_MS),
        lte: now,
      },
    },
    select: { id: true },
  });
  if (!recentTransaction) {
    logInfo(
      {
        cron: CRON_NAME,
        userId: u.id,
        workspaceId,
        activityWindowDays: MORNING_BRIEF_ACTIVITY_WINDOW_DAYS,
      },
      "brief skipped inactive workspace",
    );
    return;
  }

  if (briefType === "daily") {
    await emitDailySpending(env, u, workspaceId, now);
    return;
  }
  const context = await buildBriefContext(u.id, briefType, workspaceId);
  if (context.workspaces.length === 0) return;

  const thread = await threadsService.getOrCreateForWorkspace({
    userId: u.id,
    workspaceId,
  });
  const historyLimit = env.CHAT_HISTORY_LIMIT_MESSAGES ?? 200;
  const [recentBriefs, recentMessages] = await Promise.all([
    prisma.brief.findMany({
      where: { userId: u.id, workspaceId, type: briefType },
      orderBy: { date: "desc" },
      take: 3,
      include: { message: { select: { blocks: true } } },
    }),
    prisma.chatMessage.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: "desc" },
      take: historyLimit,
      include: { brief: { select: { id: true, type: true, date: true } } },
    }),
  ]);
  const history = selectHistoryWindow(recentMessages, {
    limitMessages: historyLimit,
    budgetTokens: env.CHAT_HISTORY_BUDGET_TOKENS ?? 16_000,
  });
  const recentTexts = recentBriefs.map((r) => briefBlocksToText(r.message.blocks));
  const blocks: PresentationBlock[] = await generateBrief(
    env,
    context,
    recentTexts,
    briefType,
    toLlmHistory(history),
    llmPromptCacheKey(`brief:${briefType}`, thread.id),
  );

  const user = await prisma.user.findUnique({
    where: { id: u.id },
    select: { categorizationMode: true },
  });
  if ((user?.categorizationMode ?? "flexible") !== "auto") {
    const lastBriefAgg = await prisma.brief.aggregate({
      where: { userId: u.id, workspaceId },
      _max: { createdAt: true },
    });
    const since = new Date(
      Math.max(
        lastBriefAgg._max.createdAt?.getTime() ?? 0,
        Date.now() - 7 * 24 * 60 * 60 * 1000,
      ),
    );
    const whereCard = {
      needsConfirmation: true,
      categoryId: { not: null },
      OR: [{ dismissedUntil: null }, { dismissedUntil: { lt: new Date() } }],
      transaction: {
        workspaceId,
        removedAt: null,
        createdAt: { gte: since },
      },
    };
    const totalCount = await prisma.transactionAllocation.count({ where: whereCard });
    if (totalCount > 0) {
      const rows = await prisma.transactionAllocation.findMany({
        where: whereCard,
        take: 5,
        select: {
          transaction: {
            select: { id: true, merchantRaw: true, merchantNormalized: true },
          },
          category: { select: { name: true } },
        },
        orderBy: { transaction: { occurredAt: "desc" } },
      });
      blocks.push({
        type: "categorize_confirm_card",
        count: totalCount,
        items: rows.map((row) => ({
          txId: row.transaction.id,
          merchant:
            row.transaction.merchantNormalized ?? row.transaction.merchantRaw,
          categoryName: row.category?.name ?? "Unknown",
        })),
        moreCount: Math.max(0, totalCount - rows.length),
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    const msg = await tx.chatMessage.create({
      data: {
        threadId: thread.id,
        role: "assistant",
        blocks: blocks as unknown as object,
      },
    });
    await tx.brief.create({
      data: {
        userId: u.id,
        workspaceId,
        type: briefType,
        date: u.localDate,
        messageId: msg.id,
      },
    });
    await tx.chatThread.update({
      where: { id: thread.id },
      data: { lastMessageAt: msg.createdAt },
    });
    logInfo(
      {
        cron: CRON_NAME,
        userId: u.id,
        workspaceId,
        briefType,
        msgId: msg.id,
        threadId: thread.id,
      },
      "brief emitted",
    );
  });

  try {
    const preview = markdownToPlainPreview(briefBlocksToText(blocks));
    await sendBriefPush(env, u.id, preview, {
      threadId: thread.id,
    });
  } catch (err) {
    logError(
      { cron: CRON_NAME, userId: u.id, workspaceId, err },
      "brief push send failed (brief is durable in DB)",
    );
  }
}

async function emitDailySpending(env: Env, u: BriefUser, workspaceId: string, now: Date): Promise<void> {
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId }, select: { name: true, currency: true },
  });
  const spending = await prisma.transaction.aggregate({
    where: {
      workspaceId, removedAt: null, billingGraceHiddenAt: null, pending: false,
      budgetImpact: "expense", amount: { gt: 0 },
      occurredAt: briefTransactionRange("daily", now, u.tz),
    },
    _sum: { amount: true }, _count: true,
  });
  // Claim before sending: concurrent ticks cannot send the same day's push twice.
  // Like report pushes, failed sends are not retried to avoid duplicate notifications.
  const claimed = await prisma.membership.updateMany({
    where: {
      userId: u.id, workspaceId,
      OR: [{ lastDailySummaryDate: null }, { lastDailySummaryDate: { lt: u.localDate } }],
    },
    data: { lastDailySummaryDate: u.localDate },
  });
  if (claimed.count === 0) return;
  const amount = new Intl.NumberFormat("en-CA", {
    style: "currency", currency: workspace.currency,
  }).format(Number(spending._sum.amount ?? 0));
  await sendBriefPush(env, u.id,
    `${workspace.name}: Yesterday you spent ${amount} · ${spending._count} transaction${spending._count === 1 ? "" : "s"}.`,
    { home: true });
}

/** Cadence rule: highest wins. */
export function determineBriefType(localDateIso: string): BriefType {
  const [y, m, d] = localDateIso.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  if (d === 1) return "monthly";
  if (dow === 1) return "weekly";
  return "daily";
}
