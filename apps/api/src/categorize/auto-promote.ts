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
  const category = await prisma.category.findFirst({
    where: { id: categoryId, workspaceId, archivedAt: null },
    select: { type: true },
  });
  if (!category) return { promoted: false, count: 0 };
  const type = category.type;
  const count = await prisma.transactionAllocation.count({
    where: {
      categoryId,
      needsConfirmation: false,
      source: { in: ["ai", "history", "manual"] },
      transaction: {
        workspaceId, merchantNormalized, removedAt: null,
        amount: type === "expense" ? { gte: 0 } : { lt: 0 },
      },
    },
  });

  if (count < 3) return { promoted: false, count };

  const existing = await prisma.merchantMapping.findUnique({
    where: { workspaceId_merchantNormalized_type: { workspaceId, merchantNormalized, type } },
    select: { categoryId: true, source: true },
  });
  const promoted = existing === null;
  if (existing?.categoryId === categoryId && existing.source === "auto") {
    return { promoted: false, count };
  }

  await prisma.merchantMapping.upsert({
    where: { workspaceId_merchantNormalized_type: { workspaceId, merchantNormalized, type } },
    create: {
      workspaceId,
      merchantNormalized,
      type,
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
