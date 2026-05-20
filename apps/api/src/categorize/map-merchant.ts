import { prisma } from "../db.js";
import { normalizeMerchant } from "./normalize.js";

export type MapMerchantInput = { categoryId: string; merchant: string };
export type MapMerchantOutput = {
  mapping: { merchantNormalized: string; categoryId: string };
  backfilledCount: number;
};

export async function mapMerchantToCategoryService(
  ctx: { workspaceId: string },
  input: MapMerchantInput,
): Promise<MapMerchantOutput> {
  const merchantNormalized = normalizeMerchant(input.merchant);
  if (merchantNormalized.length === 0) {
    throw new Error("invalid_merchant");
  }

  const category = await prisma.category.findFirst({
    where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
    select: { id: true },
  });
  if (!category) throw new Error("category_not_found");

  await prisma.$transaction(async (db) => {
    await db.merchantMapping.upsert({
      where: {
        workspaceId_merchantNormalized: {
          workspaceId: ctx.workspaceId,
          merchantNormalized,
        },
      },
      create: {
        workspaceId: ctx.workspaceId,
        merchantNormalized,
        categoryId: input.categoryId,
        source: "manual",
        confidence: 1.0,
      },
      update: {
        categoryId: input.categoryId,
        source: "manual",
        confidence: 1.0,
      },
    });

    // Step 1: normalize NULL-merchantNormalized siblings whose raw text
    // matches. Mirrors apps/api/src/categorize/manual-categorize.ts:81-97.
    const prefix =
      merchantNormalized.length >= 3 ? merchantNormalized.slice(0, 3) : merchantNormalized;
    const nullSiblings = await db.transaction.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        merchantNormalized: null,
        merchantRaw: { mode: "insensitive", contains: prefix },
      },
      select: { id: true, merchantRaw: true },
    });
    for (const ns of nullSiblings) {
      if (normalizeMerchant(ns.merchantRaw) === merchantNormalized) {
        await db.transaction.update({
          where: { id: ns.id },
          data: { merchantNormalized },
        });
      }
    }
  });

  // Step 2: assign category to all null-category, non-removed siblings whose
  // merchantNormalized now matches (covers both pre-normalized and just-
  // normalized rows from step 1). Use per-row atomic guard to avoid clobbering
  // split tx (N≥2 allocations) or already-categorized allocations.
  const candidates = await prisma.transaction.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      merchantNormalized,
      removedAt: null,
      allocations: { some: {}, every: { categoryId: null, source: null } },
    },
    include: { allocations: { select: { id: true } } },
  });
  let backfilledCount = 0;
  for (const c of candidates) {
    if (c.allocations.length !== 1) continue;
    const a = c.allocations[0]!;
    const upd = await prisma.transactionAllocation.updateMany({
      where: { id: a.id, categoryId: null, source: null },
      data: { categoryId: input.categoryId, source: "mapping" },
    });
    if (upd.count > 0) {
      backfilledCount += 1;
    }
  }

  return {
    mapping: { merchantNormalized, categoryId: input.categoryId },
    backfilledCount,
  };
}
