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

  const existing = await prisma.merchantMapping.findUnique({
    where: { workspaceId_merchantNormalized: { workspaceId, merchantNormalized } },
    select: { categoryId: true, source: true },
  });
  const promoted = existing === null;
  if (existing?.categoryId === categoryId && existing.source === "auto") {
    return { promoted: false, count };
  }

  await prisma.merchantMapping.upsert({
    where: { workspaceId_merchantNormalized: { workspaceId, merchantNormalized } },
    create: {
      workspaceId,
      merchantNormalized,
      categoryId,
      confidence: 1.0,
      source: "auto",
    },
    update: { categoryId, confidence: 1.0, source: "auto" },
  });

  logInfo(
    { workspaceId, merchantNormalized, categoryId, confirmCount: count },
    "mapping.auto_promoted",
  );
  return { promoted, count };
}
