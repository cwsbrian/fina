import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { logInfo, logError } from "../../logger.js";
import type { Env } from "../../env.js";
import { partsInTz, resolveTz } from "../../chat/tools/periods.js";
import { buildBriefContext, type BriefContext, type BriefType } from "../../chat/brief-context.js";
import { generateBrief, briefBlocksToText } from "../../chat/brief.js";
import type { PresentationBlock } from "../../chat/blocks.js";
import { sendBriefPush } from "../../push/send.js";
import { markdownToPlainPreview } from "../../push/markdown-preview.js";

const CRON_NAME = "daily-brief";
const pad2 = (n: number) => String(n).padStart(2, "0");

/** Daily-brief cron entry. Selects users whose local time matches
 *  morningTime and have no Brief row for today; for each, generates a
 *  brief and emits it atomically with a chat message in their unbound
 *  thread. Per-user try/catch isolates LLM failures so one user's
 *  LLM hiccup doesn't break the tick for others. */
export async function runDailyBrief(env: Env): Promise<void> {
  // 1. Candidate users (DB filter — fast).
  const candidates = await prisma.user.findMany({
    where: {
      pauseEnabled: false,
      OR: [{ snoozeUntil: null }, { snoozeUntil: { lt: new Date() } }],
    },
    select: { id: true, morningTime: true, morningBriefFrequency: true, tz: true },
  });
  if (candidates.length === 0) return;

  // 2. App-side filter (tz-aware time + idempotency). Synchronous —
  //    candidates already include u.tz; resolveTz is pure CPU (validates
  //    against IANA list, falls back to DEFAULT_TZ) so no DB roundtrip.
  type Enriched = {
    id: string;
    morningTime: string;
    morningBriefFrequency: string;
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
      morningBriefFrequency: u.morningBriefFrequency,
      tz,
      localHHmm: `${pad2(p.hour)}:${pad2(p.minute)}`,
      localDate: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    };
  });
  const timeMatched = enriched.filter((u) => u.localHHmm === u.morningTime);
  if (timeMatched.length === 0) return;

  // 3. Bulk idempotency check (single query — NOT N+1).
  const today = await prisma.brief.findMany({
    where: {
      userId: { in: timeMatched.map((u) => u.id) },
      date: { in: timeMatched.map((u) => u.localDate) },
    },
    select: { userId: true, date: true },
  });
  const briefed = new Set(today.map((b) => `${b.userId}|${b.date}`));
  const matchUsers = timeMatched.filter((u) => !briefed.has(`${u.id}|${u.localDate}`));
  if (matchUsers.length === 0) return;

  // 4. Per-user pipeline.
  for (const u of matchUsers) {
    try {
      const briefType = determineBriefType(u.localDate);
      const context = await buildBriefContext(u.id, briefType);
      let dailyForecastState: ForecastAlertState | null = null;
      let mentionForecast = true;
      if (briefType === "daily") {
        dailyForecastState = snapshotForecastState(context);
        const previous = await prisma.brief.findFirst({
          where: {
            userId: u.id,
            type: "daily",
            forecastState: { not: Prisma.DbNull },
          },
          orderBy: [{ date: "desc" }, { createdAt: "desc" }],
          select: { forecastState: true },
        });
        mentionForecast = shouldMentionDailyForecast(
          dailyForecastState,
          parseForecastState(previous?.forecastState),
        );
        if (!mentionForecast) {
          for (const workspace of context.workspaces) workspace.forecast.mention = false;
        }
      }
      if (u.morningBriefFrequency === "issues_only" && !hasBriefIssues(context)) {
        logInfo({ cron: CRON_NAME, userId: u.id, briefType }, "brief skipped quiet day");
        continue;
      }

      const recent = await prisma.brief.findMany({
        where: { userId: u.id, type: briefType },
        orderBy: { date: "desc" },
        take: 3,
        include: { message: { select: { blocks: true } } },
      });
      const recentTexts = recent.map((r) => briefBlocksToText(r.message.blocks));

      const blocks: PresentationBlock[] = await generateBrief(env, context, recentTexts, briefType);

      // Categorize confirm card (Plan 1F).
      const u2 = await prisma.user.findUnique({
        where: { id: u.id },
        select: { categorizationMode: true },
      });
      const mode = u2?.categorizationMode ?? "flexible";
      if (mode !== "auto") {
        const lastBriefAgg = await prisma.brief.aggregate({
          where: { userId: u.id },
          _max: { createdAt: true },
        });
        const sinceMs = Math.max(
          lastBriefAgg._max.createdAt?.getTime() ?? 0,
          Date.now() - 7 * 24 * 60 * 60 * 1000,
        );
        const since = new Date(sinceMs);
        const whereCard = {
          needsConfirmation: true,
          categoryId: { not: null },
          OR: [{ dismissedUntil: null }, { dismissedUntil: { lt: new Date() } }],
          transaction: {
            removedAt: null,
            workspace: { memberships: { some: { userId: u.id } } },
            createdAt: { gte: since },
          },
        };
        const totalCount = await prisma.transactionAllocation.count({ where: whereCard });
        if (totalCount > 0) {
          const rows = await prisma.transactionAllocation.findMany({
            where: whereCard,
            take: 5,
            select: {
              transaction: { select: { id: true, merchantRaw: true, merchantNormalized: true } },
              category: { select: { name: true } },
            },
            orderBy: { transaction: { occurredAt: "desc" } },
          });
          const items = rows.map((r) => ({
            txId: r.transaction.id,
            merchant: r.transaction.merchantNormalized ?? r.transaction.merchantRaw,
            categoryName: r.category?.name ?? "Unknown",
          }));
          blocks.push({
            type: "categorize_confirm_card",
            count: totalCount,
            items,
            moreCount: Math.max(0, totalCount - items.length),
          });
        }
      }

      // Find-or-create unbound thread. Race tolerated.
      let thread = await prisma.chatThread.findFirst({
        where: { userId: u.id, workspaceId: null, archivedAt: null },
        orderBy: { createdAt: "desc" },
      });
      if (!thread) {
        thread = await prisma.chatThread.create({
          data: { userId: u.id, workspaceId: null },
        });
      }
      const threadIdLocal = thread.id;

      // Atomic emit — message + brief together.
      const emitted = await prisma.$transaction(async (tx) => {
        const msg = await tx.chatMessage.create({
          data: {
            threadId: threadIdLocal,
            role: "assistant",
            blocks: blocks as unknown as object,
          },
        });
        const brief = await tx.brief.create({
          data: {
            userId: u.id,
            type: briefType,
            date: u.localDate,
            messageId: msg.id,
          },
        });
        logInfo(
          { cron: CRON_NAME, userId: u.id, briefType, msgId: msg.id, threadId: threadIdLocal },
          "brief emitted",
        );
        return { briefId: brief.id };
      });

      // Push notification (Plan 2C). Best-effort — brief is already in
      // DB so push failure doesn't lose user data. sendBriefPush checks
      // the user's notificationPrefs.morningBrief internally and skips
      // if the user opted out of the push (the brief still landed in
      // their chat).
      try {
        const briefText = briefBlocksToText(blocks);
        const preview = markdownToPlainPreview(briefText);
        const result = await sendBriefPush(env, u.id, preview, { threadId: threadIdLocal });
        if (dailyForecastState && mentionForecast && result.sent > 0) {
          await prisma.brief.update({
            where: { id: emitted.briefId },
            data: { forecastState: dailyForecastState as unknown as Prisma.InputJsonValue },
          });
        }
      } catch (err) {
        logError(
          { cron: CRON_NAME, userId: u.id, err },
          "brief push send failed (brief is durable in DB)",
        );
      }
    } catch (err) {
      logError({ cron: CRON_NAME, userId: u.id, err }, "brief generation failed");
    }
  }
}

/** Cadence rule: highest wins. */
function determineBriefType(localDateIso: string): BriefType {
  const [y, m, d] = localDateIso.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  if (d === 1) return "monthly";
  if (dow === 1) return "weekly";
  return "daily";
}

function hasBriefIssues(context: BriefContext): boolean {
  return context.workspaces.some((w) => {
    const portfolioSeverity = w.forecast.portfolio?.severity;
    const hasForecastIssue =
      w.forecast.mention &&
      (portfolioSeverity === "watch" ||
        portfolioSeverity === "at_risk" ||
        w.forecast.topRisks.length > 0);
    return (
      hasForecastIssue ||
      (context.briefType !== "daily" && w.forecast.historicalPatterns.length > 0) ||
      w.newTransactions.count > 0 ||
      w.uncategorizedCount > 0 ||
      w.schedule.length > 0 ||
      w.recurring.length > 0
    );
  });
}

type ForecastRiskState = {
  category: string;
  severity: "watch" | "at_risk";
  overspend: number;
};

type WorkspaceForecastAlertState = {
  id: string;
  portfolioSeverity: "none" | "on_track" | "watch" | "at_risk";
  portfolioOverspend: number;
  risks: ForecastRiskState[];
  scheduledEvidence: string[];
};

export type ForecastAlertState = {
  version: 1;
  workspaces: WorkspaceForecastAlertState[];
};

/** Stable, sentence-independent state used only for Daily forecast dedupe. */
export function snapshotForecastState(context: BriefContext): ForecastAlertState {
  const workspaces = context.workspaces
    .map((workspace): WorkspaceForecastAlertState => ({
      id: workspace.id,
      portfolioSeverity: workspace.forecast.portfolio?.severity ?? "none",
      portfolioOverspend: moneyNumber(workspace.forecast.portfolio?.overspend ?? "0"),
      risks: workspace.forecast.topRisks
        .map((risk) => ({
          category: risk.category,
          severity: risk.severity,
          overspend: moneyNumber(risk.overspend),
        }))
        .sort((a, b) => a.category.localeCompare(b.category)),
      scheduledEvidence: [
        ...workspace.schedule.map(
          (item) => `scheduled|${item.category}|${item.amount}|${item.date}`,
        ),
        ...workspace.recurring.map(
          (item) => `recurring|${item.merchant}|${item.amount}|${item.nextDate}`,
        ),
      ].sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, workspaces };
}

/** True only for a first alert or a meaningful structured state change. */
export function shouldMentionDailyForecast(
  current: ForecastAlertState,
  previous: ForecastAlertState | null,
): boolean {
  if (!previous) return true;
  if (current.workspaces.length !== previous.workspaces.length) return true;

  const previousById = new Map(previous.workspaces.map((workspace) => [workspace.id, workspace]));
  for (const workspace of current.workspaces) {
    const before = previousById.get(workspace.id);
    if (!before || workspace.portfolioSeverity !== before.portfolioSeverity) return true;
    if (workspace.risks.length !== before.risks.length) return true;

    const beforeRisks = new Map(before.risks.map((risk) => [risk.category, risk]));
    for (const risk of workspace.risks) {
      const oldRisk = beforeRisks.get(risk.category);
      if (!oldRisk || oldRisk.severity !== risk.severity) return true;
      if (meaningfullyDifferent(risk.overspend, oldRisk.overspend)) return true;
    }

    const hasRisk =
      workspace.portfolioSeverity === "watch" ||
      workspace.portfolioSeverity === "at_risk" ||
      before.portfolioSeverity === "watch" ||
      before.portfolioSeverity === "at_risk" ||
      workspace.risks.length > 0 ||
      before.risks.length > 0;
    if (hasRisk && meaningfullyDifferent(workspace.portfolioOverspend, before.portfolioOverspend)) {
      return true;
    }
    if (
      hasRisk &&
      workspace.scheduledEvidence.join("\n") !== before.scheduledEvidence.join("\n")
    ) {
      return true;
    }
  }
  return false;
}

function parseForecastState(value: unknown): ForecastAlertState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ForecastAlertState>;
  return candidate.version === 1 && Array.isArray(candidate.workspaces)
    ? (candidate as ForecastAlertState)
    : null;
}

function moneyNumber(display: string): number {
  const value = Number(display.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

function meaningfullyDifferent(current: number, previous: number): boolean {
  const threshold = Math.max(50, Math.abs(previous) * 0.1);
  return Math.abs(current - previous) >= threshold;
}
