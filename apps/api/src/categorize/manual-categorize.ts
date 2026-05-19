import { prisma } from "../db.js";
import { normalizeMerchant } from "./normalize.js";
import { withWorkspaceLock } from "../locks/workspace.js";

export class ManualCategorizeError extends Error {
  constructor(public code: "tx_not_found" | "category_not_found") {
    super(code);
    this.name = "ManualCategorizeError";
  }
}

export type ManualCategorizeInput = {
  workspaceId: string;
  txId: string;
  categoryName: string;
};

export type ManualCategorizeResult = {
  tx: {
    id: string;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string | null;
    categoryId: string | null;
    categorizationSource: "manual" | "mapping" | "ai" | null;
    occurredAt: Date;
  };
  backfilledCount: number;
};

export async function applyManualCategorize(
  input: ManualCategorizeInput,
): Promise<ManualCategorizeResult> {
  const trimmedName = input.categoryName.trim();
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: input.workspaceId },
    select: { currency: true },
  });

  // Category lookup stays OUTSIDE the lock: read-only, pre-existing archive
  // races are not introduced by this plan, and keeping it outside means the
  // lock scope is no larger than the read+writes that actually mutate state.
  const category = await prisma.category.findFirst({
    where: {
      workspaceId: input.workspaceId,
      archivedAt: null,
      name: { equals: trimmedName, mode: "insensitive" },
    },
    select: { id: true, name: true },
  });
  if (!category) throw new ManualCategorizeError("category_not_found");

  const result = await withWorkspaceLock(input.workspaceId, async (tx) => {
    // Re-read INSIDE the lock so a concurrent PATCH that writes merchantRaw +
    // merchantNormalized is visible here — we must normalize from the
    // post-PATCH merchantRaw, not a stale snapshot.
    const txRow = await tx.transaction.findFirst({
      where: { id: input.txId, workspaceId: input.workspaceId },
      select: { id: true, merchantRaw: true, merchantNormalized: true },
    });
    if (!txRow) throw new ManualCategorizeError("tx_not_found");

    const merchantNorm = txRow.merchantNormalized ?? normalizeMerchant(txRow.merchantRaw);

    await tx.transaction.update({
      where: { id: txRow.id },
      data: {
        merchantNormalized: merchantNorm,
        categoryId: category.id,
        categorizationSource: "manual",
      },
    });

    await tx.merchantMapping.upsert({
      where: {
        workspaceId_merchantNormalized: {
          workspaceId: input.workspaceId,
          merchantNormalized: merchantNorm,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        merchantNormalized: merchantNorm,
        categoryId: category.id,
        confidence: 1.0,
        source: "manual",
      },
      update: { categoryId: category.id, source: "manual", confidence: 1.0 },
    });

    const nullSiblings = await tx.transaction.findMany({
      where: {
        workspaceId: input.workspaceId,
        merchantNormalized: null,
        merchantRaw: {
          mode: "insensitive",
          contains: trimmedName.length >= 3 ? merchantNorm.slice(0, 3) : merchantNorm,
        },
      },
      select: { id: true, merchantRaw: true },
    });
    for (const ns of nullSiblings) {
      const norm = normalizeMerchant(ns.merchantRaw);
      if (norm === merchantNorm) {
        await tx.transaction.update({ where: { id: ns.id }, data: { merchantNormalized: norm } });
      }
    }

    const backfilled = await tx.transaction.updateMany({
      where: {
        workspaceId: input.workspaceId,
        merchantNormalized: merchantNorm,
        id: { not: txRow.id },
        OR: [
          { categorizationSource: null },
          { categorizationSource: { not: "manual" } },
        ],
      },
      data: { categoryId: category.id, categorizationSource: "mapping" },
    });

    return { backfilledCount: backfilled.count };
  });

  const updated = await prisma.transaction.findUniqueOrThrow({
    where: { id: input.txId },
    select: {
      id: true, amount: true, merchantRaw: true, merchantNormalized: true,
      categoryId: true, categorizationSource: true, occurredAt: true,
    },
  });

  return {
    tx: {
      id: updated.id,
      amount: updated.amount.toString(),
      currency: workspace.currency,
      merchantRaw: updated.merchantRaw,
      merchantNormalized: updated.merchantNormalized,
      categoryId: updated.categoryId,
      categorizationSource: updated.categorizationSource,
      occurredAt: updated.occurredAt,
    },
    backfilledCount: result.backfilledCount,
  };
}
