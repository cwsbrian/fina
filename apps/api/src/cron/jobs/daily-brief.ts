import { prisma } from "../../db.js";
import { logInfo, logError } from "../../logger.js";
import type { Env } from "../../env.js";
import { partsInTz, resolveTz } from "../../chat/tools/periods.js";
import { buildBriefContext, type BriefType } from "../../chat/brief-context.js";
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
 *  Gemini hiccup doesn't break the tick for others. */
export async function runDailyBrief(env: Env): Promise<void> {
  // 1. Candidate users (DB filter — fast).
  const candidates = await prisma.user.findMany({
    where: {
      pauseEnabled: false,
      OR: [{ snoozeUntil: null }, { snoozeUntil: { lt: new Date() } }],
    },
    select: { id: true, morningTime: true, tz: true },
  });
  if (candidates.length === 0) return;

  // 2. App-side filter (tz-aware time + idempotency). Synchronous —
  //    candidates already include u.tz; resolveTz is pure CPU (validates
  //    against IANA list, falls back to DEFAULT_TZ) so no DB roundtrip.
  type Enriched = { id: string; morningTime: string; tz: string; localHHmm: string; localDate: string };
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
      await prisma.$transaction(async (tx) => {
        const msg = await tx.chatMessage.create({
          data: {
            threadId: threadIdLocal,
            role: "assistant",
            blocks: blocks as unknown as object,
          },
        });
        await tx.brief.create({
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
      });

      // Push notification (Plan 2C). Best-effort — brief is already in
      // DB so push failure doesn't lose user data. sendBriefPush checks
      // the user's notificationPrefs.morningBrief internally and skips
      // if the user opted out of the push (the brief still landed in
      // their chat).
      try {
        const briefText = briefBlocksToText(blocks);
        const preview = markdownToPlainPreview(briefText);
        await sendBriefPush(env, u.id, preview);
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
  const dow = new Date(Date.UTC(y!, (m! - 1), d!)).getUTCDay();
  if (d === 1) return "monthly";
  if (dow === 1) return "weekly";
  return "daily";
}
