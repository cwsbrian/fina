import { prisma } from "../db.js";
import { normalizeMerchant } from "./normalize.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import { applyAllocations } from "../transactions/allocations.js";
import { maybeAutoPromote } from "./auto-promote.js";
import { syncTransactionImpact } from "../transactions/refunds.js";

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
      source: "manual" | "mapping" | "ai" | "history" | null;
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

    const type = txRow.amount.gte(0) ? "expense" : "income";
    const category = await tx.category.findFirst({
      where: {
        workspaceId: input.workspaceId, archivedAt: null, type,
        name: { equals: trimmedName, mode: "insensitive" },
      },
      select: { id: true, name: true },
    });
    if (!category) throw new ManualCategorizeError("category_not_found");

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

    // Clear new flag fields on the just-written allocations. Defaults already
    // give us needsConfirmation=false + dismissedUntil=null, but for split→single
    // transitions or future refactors we set explicitly.
    await tx.transactionAllocation.updateMany({
      where: { transactionId: txRow.id },
      data: { needsConfirmation: false, dismissedUntil: null },
    });
    await syncTransactionImpact(tx, txRow.id);

    // Update merchantNormalized on the transaction.
    await tx.transaction.update({
      where: { id: txRow.id },
      data: { merchantNormalized: merchantNorm },
    });

    // Keep separate rules for money in and money out at the same merchant.
    await tx.merchantMapping.upsert({
      where: {
        workspaceId_merchantNormalized_type: {
          workspaceId: input.workspaceId,
          merchantNormalized: merchantNorm,
          type,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        merchantNormalized: merchantNorm,
        type,
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
        removedAt: null,  // align with map-merchant.ts; don't back-fill soft-removed siblings
        amount: type === "expense" ? { gte: 0 } : { lt: 0 },
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
        where: {
          id: a.id,
          transaction: { workspaceId: input.workspaceId },  // defense-in-depth TOCTOU guard
          OR: [{ source: null }, { source: { not: "manual" } }],
        },
        data: { categoryId: category.id, source: "mapping" },
      });
      if (upd.count > 0) {
        backfilledCount += 1;
        await syncTransactionImpact(tx, sib.id);
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

  // Per-allocation auto-promote trigger (best-effort, post-commit).
  if (updated.merchantNormalized) {
    for (const a of updated.allocations) {
      if (a.categoryId) {
        await maybeAutoPromote(input.workspaceId, updated.merchantNormalized, a.categoryId);
      }
    }
  }

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
