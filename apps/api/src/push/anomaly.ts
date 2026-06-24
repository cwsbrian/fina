import { prisma } from "../db.js";
import { logError } from "../logger.js";
import type { Env } from "../env.js";
import { sendLargeChargePush } from "./send.js";
import { budgetExpenseAllocationWhere } from "../transactions/budget-impact.js";

/** Minimum tx amount worth notifying about. Avoids spamming users
 *  whose $4 coffee just doubled to $8. */
const MIN_AMOUNT = 30;
/** Multiplier above the category's last-90-day average that flags as
 *  unusual. 2.5× the mean is the lightweight stand-in for a proper
 *  mean+2σ check; cheap to compute and false-positive-tolerant. */
const MULTIPLIER = 2.5;
/** Fallback threshold when the category has no recent history. */
const COLD_START_AMOUNT = 150;

/** Check whether a freshly-created transaction looks unusually large
 *  against its category's recent baseline. Fire-and-forget — caller
 *  passes the carrier env and the new row; we look up history,
 *  evaluate, and push to every owner/editor of the workspace.
 *  Best-effort: errors are logged but never thrown back to the caller
 *  (a notification failure must not block transaction ingest). */
export async function checkLargeChargeAndPush(
  env: Env,
  args: {
    transactionId: string;
    workspaceId: string;
    amount: number;
    merchant: string | null;
  },
): Promise<void> {
  try {
    if (args.amount < MIN_AMOUNT) return;

    // Find this tx's primary categoryId via its first allocation. Manual
    // create + Plaid sync both write an initial allocation row.
    const tx = await prisma.transaction.findUnique({
      where: { id: args.transactionId },
      select: {
        allocations: {
          select: { categoryId: true, category: { select: { name: true } } },
          take: 1,
        },
      },
    });
    const allocation = tx?.allocations[0];
    if (!allocation?.categoryId) return; // uncategorized — skip
    const categoryId = allocation.categoryId;
    const categoryName = allocation.category?.name ?? null;

    // Last 90 days of expense allocations on this category, excluding
    // the new row.
    const since = new Date(Date.now() - 90 * 86_400_000);
    const recent = await prisma.transactionAllocation.findMany({
      where: {
        ...budgetExpenseAllocationWhere({
          workspaceId: args.workspaceId,
          occurredAt: { gte: since },
        }),
        categoryId,
        transactionId: { not: args.transactionId },
      },
      select: { amount: true },
    });

    let isUnusual = false;
    if (recent.length === 0) {
      // Cold-start: no history. Use a flat $ threshold so the first
      // big charge in a brand-new category still flags.
      isUnusual = args.amount >= COLD_START_AMOUNT;
    } else {
      const sum = recent.reduce((s, r) => s + Number(r.amount), 0);
      const avg = sum / recent.length;
      isUnusual = args.amount >= avg * MULTIPLIER && args.amount >= MIN_AMOUNT * 2;
    }
    if (!isUnusual) return;

    const memberships = await prisma.membership.findMany({
      where: {
        workspaceId: args.workspaceId,
        role: { in: ["owner", "editor"] },
      },
      select: { userId: true },
    });
    for (const m of memberships) {
      // Per-recipient try/catch: a transient error on one member must NOT
      // drop the tail of the fan-out (per Plan 1U).
      try {
        await sendLargeChargePush(
          env,
          m.userId,
          args.merchant ?? "An unusual charge",
          args.amount.toFixed(2),
          categoryName,
        );
      } catch (err) {
        logError(
          { transactionId: args.transactionId, recipientUserId: m.userId, err },
          "large-charge push to recipient failed",
        );
      }
    }
  } catch (err) {
    logError(
      { transactionId: args.transactionId, err },
      "large-charge anomaly check failed",
    );
  }
}
