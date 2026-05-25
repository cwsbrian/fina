import { prisma } from "../db.js";
import { logInfo } from "../logger.js";

/** Counts confirmed allocations (needsConfirmation=false) for this
 *  (workspace, merchantNormalized, categoryId) tuple where source is
 *  'ai', 'history', or 'manual'. If count >= 3, inserts an explicit
 *  merchant_mappings row (source='auto'), idempotent via skipDuplicates.
 *  Excludes source='mapping' from the count (would be self-counting). */
export async function maybeAutoPromote(
  workspaceId: string,
  merchantNormalized: string,
  categoryId: string,
): Promise<{ promoted: boolean; count: number }> {
  const count = await prisma.transactionAllocation.count({
    where: {
      categoryId,
      needsConfirmation: false,
      source: { in: ["ai", "history", "manual"] },
      transaction: { workspaceId, merchantNormalized, removedAt: null },
    },
  });

  if (count < 3) return { promoted: false, count };

  const insert = await prisma.merchantMapping.createMany({
    data: [{
      workspaceId,
      merchantNormalized,
      categoryId,
      confidence: 1.0,
      source: "auto",
    }],
    skipDuplicates: true,
  });

  const promoted = insert.count > 0;
  if (promoted) {
    logInfo(
      { workspaceId, merchantNormalized, categoryId, confirmCount: count },
      "mapping.auto_promoted",
    );
  }
  return { promoted, count };
}
