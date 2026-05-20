import { prisma } from "../db.js";
import { normalizeMerchant } from "./normalize.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import { applyAllocations } from "../transactions/allocations.js";

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
    needsReclassification: boolean;
    occurredAt: Date;
    allocations: Array<{
      id: string;
      categoryId: string | null;
      amount: string;
      source: "manual" | "mapping" | "ai" | null;
    }>;
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
    // merchantNormalized is visible here — we must normalize from the post-PATCH
    // merchantRaw, not a stale snapshot.
    const txRow = await tx.transaction.findFirst({
      where: { id: input.txId, workspaceId: input.workspaceId },
      select: { id: true, amount: true, merchantRaw: true, merchantNormalized: true },
    });
    if (!txRow) throw new ManualCategorizeError("tx_not_found");

    const merchantNorm = txRow.merchantNormalized ?? normalizeMerchant(txRow.merchantRaw);

    // Primary: write allocations via the helper (single entry).
    // Amount is Decimal(14, 2); Number(d.toString()) round-trips cleanly for
    // any value in that range. applyAllocations will re-stringify the number
    // for its AMOUNT_RE regex validator.
    await applyAllocations(
      tx,
      input.workspaceId,
      txRow.id,
      txRow.amount,
      "manual",
      [{ categoryId: category.id, amount: Number(txRow.amount.toString()) }],
    );

    // Update merchantNormalized on the transaction.
    await tx.transaction.update({
      where: { id: txRow.id },
      data: { merchantNormalized: merchantNorm },
    });

    // Merchant mapping upsert (unchanged).
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

    // Sibling normalization (unchanged) — back-fills merchantNormalized for legacy NULL rows.
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

    // Sibling category back-fill — unified rule per spec §6.3:
    //   target sibling has exactly 1 allocation; that allocation is null-cat
    //   OR source != "manual"; skip N≥2 siblings entirely.
    const siblings = await tx.transaction.findMany({
      where: {
        workspaceId: input.workspaceId,
        merchantNormalized: merchantNorm,
        id: { not: txRow.id },
        allocations: { some: {} },
      },
      include: { allocations: { select: { id: true, source: true } } },
    });
    let backfilledCount = 0;
    for (const sib of siblings) {
      if (sib.allocations.length !== 1) continue; // skip splits
      const a = sib.allocations[0]!;
      if (a.source === "manual") continue; // don't overwrite user-confirmed
      // Atomic per-row update with guard: only update if still not manual.
      // Use OR to handle NULL source correctly (NULL != 'manual' is NULL in SQL).
      const upd = await tx.transactionAllocation.updateMany({
        where: { id: a.id, OR: [{ source: null }, { source: { not: "manual" } }] },
        data: { categoryId: category.id, source: "mapping" },
      });
      if (upd.count > 0) {
        backfilledCount += 1;
      }
    }

    return { backfilledCount };
  });

  const updated = await prisma.transaction.findUniqueOrThrow({
    where: { id: input.txId },
    select: {
      id: true, amount: true, merchantRaw: true, merchantNormalized: true,
      occurredAt: true, needsReclassification: true,
      allocations: {
        select: { id: true, categoryId: true, amount: true, source: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  return {
    tx: {
      id: updated.id,
      amount: updated.amount.toString(),
      currency: workspace.currency,
      merchantRaw: updated.merchantRaw,
      merchantNormalized: updated.merchantNormalized,
      needsReclassification: updated.needsReclassification,
      occurredAt: updated.occurredAt,
      allocations: updated.allocations.map((a) => ({
        id: a.id,
        categoryId: a.categoryId,
        amount: a.amount.toString(),
        source: a.source,
      })),
    },
    backfilledCount: result.backfilledCount,
  };
}
