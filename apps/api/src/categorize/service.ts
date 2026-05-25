import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { normalizeMerchant } from "./normalize.js";
import { callGeminiCategorize, type LLMTransaction } from "./llm.js";
import { logError } from "../logger.js";
import { findHistoryHints } from "./history-lookup.js";
import { computeNeedsConfirmation } from "./needs-confirmation.js";
import { isOtherCategory } from "./other-detection.js";
import { emitCategorizeCompleted } from "../telemetry/categorize.js";

/**
 * Categorize a list of newly-inserted transactions in a workspace.
 *
 * Flow:
 *  1. For each tx, normalize merchantRaw → store merchantNormalized.
 *  2. Look up merchant_mappings (JOIN active categories only). Mapped tx
 *     get categoryId + source='mapping' instantly.
 *  3. Remaining tx are batched (CATEGORIZE_BATCH_MAX per call) and sent to
 *     Gemini. Valid responses get categoryId + source='ai'.
 *  4. Failures (LLM error, unknown category, unknown tx_id) leave the tx
 *     uncategorized. No retry in the same call.
 *
 * All writes guard by allocation-level `WHERE categoryId IS NULL AND source IS NULL`
 * to avoid overwriting a manual decision that races with our LLM call.
 *
 * Best-effort: this function does NOT throw on Gemini failures. Callers can
 * treat it as fire-and-forget (exchange route) or await it (manual sync).
 */
export async function categorizeNewTransactions(
  env: Env,
  workspaceId: string,
  newTxIds: string[],
): Promise<void> {
  if (newTxIds.length === 0) return;

  // Resolve mode from the workspace owner's user record. (Plan v3: user-level mode,
  // sync runs workspace-scoped, so owner's mode applies. v2 may revisit.)
  const owner = await prisma.membership.findFirst({
    where: { workspaceId, role: "owner" },
    select: { user: { select: { categorizationMode: true } } },
  });
  const mode = owner?.user.categorizationMode ?? "flexible";

  // Step 1: Load tx + populate merchantNormalized on each row.
  // Use allocation-based predicate so this filter survives Task 8's column drop.
  const txs = await prisma.transaction.findMany({
    where: {
      id: { in: newTxIds },
      workspaceId,
      removedAt: null,  // don't categorize soft-removed tx
      allocations: { some: {}, every: { categoryId: null, source: null } },
    },
    select: {
      id: true,
      merchantRaw: true,
      merchantNormalized: true,
      amount: true,
      occurredAt: true,
      rawData: true,
      allocations: { select: { id: true } },
    },
  });

  // Sort txs to match the caller-supplied newTxIds order so that batching is
  // deterministic (important when batchMax < total unmapped count).
  const txOrder = new Map(newTxIds.map((id, i) => [id, i]));
  const sortedTxs = [...txs].sort((a, b) => (txOrder.get(a.id) ?? 0) - (txOrder.get(b.id) ?? 0));

  // Filter to exactly 1 allocation — Prisma can't express "exactly one" in a where clause.
  // Split tx (N≥2) are excluded per spec §6.2.
  const singleAllocTxs = sortedTxs.filter((t) => t.allocations.length === 1);

  type Loaded = {
    id: string;
    merchantRaw: string;
    merchantNormalized: string;
    amount: number;
    occurredAt: Date;
    rawData: unknown;
    allocationId: string;
  };
  const loaded: Loaded[] = [];
  for (const t of singleAllocTxs) {
    const normalized = t.merchantNormalized ?? normalizeMerchant(t.merchantRaw);
    if (t.merchantNormalized !== normalized) {
      await prisma.transaction.update({
        where: { id: t.id, workspaceId },
        data: { merchantNormalized: normalized },
      });
    }
    loaded.push({
      id: t.id,
      merchantRaw: t.merchantRaw,
      merchantNormalized: normalized,
      amount: Number(t.amount),
      occurredAt: t.occurredAt,
      rawData: t.rawData,
      allocationId: t.allocations[0]!.id,
    });
  }

  // Step 2: Mapping lookup (JOIN categories on archivedAt IS NULL — archived
  // mappings don't apply).
  const normalizedSet = [...new Set(loaded.map((t) => t.merchantNormalized))];
  const mappings =
    normalizedSet.length === 0
      ? []
      : await prisma.merchantMapping.findMany({
          where: {
            workspaceId,
            merchantNormalized: { in: normalizedSet },
            category: { archivedAt: null },
          },
          select: { merchantNormalized: true, categoryId: true },
        });
  const mappingByNorm = new Map(mappings.map((m) => [m.merchantNormalized, m.categoryId]));

  const unmapped: Loaded[] = [];
  for (const t of loaded) {
    const catId = mappingByNorm.get(t.merchantNormalized);
    if (catId) {
      // Find tx with N=1 null-cat allocation matching merchantNormalized, update
      // via per-row atomic guard. Idempotent against concurrent user PATCH.
      const candidates = await prisma.transaction.findMany({
        where: {
          workspaceId,
          merchantNormalized: t.merchantNormalized,
          removedAt: null,
          allocations: { some: {}, every: { categoryId: null, source: null } },
        },
        include: { allocations: { select: { id: true } } },
      });
      for (const c of candidates) {
        if (c.allocations.length !== 1) continue;
        const a = c.allocations[0]!;
        // Idempotent atomic write — only fires if the allocation is still null/null.
        const upd = await prisma.transactionAllocation.updateMany({
          where: { id: a.id, categoryId: null, source: null },
          data: { categoryId: catId, source: "mapping", needsConfirmation: false, dismissedUntil: null },
        });
        if (upd.count > 0) {
          const mapCat = await prisma.category.findUnique({ where: { id: catId }, select: { name: true } });
          emitCategorizeCompleted({
            workspaceId,
            source: "mapping",
            categoryName: mapCat?.name ?? "?",
            pfcPrimary: null,
            pfcConfidence: null,
            pfcMissing: true,
          });
        }
      }
    } else {
      unmapped.push(t);
    }
  }

  // Step 2: History lookup (batch).
  const historyMerchants = [...new Set(unmapped.map((t) => t.merchantNormalized))];
  const historyHints = await findHistoryHints(workspaceId, historyMerchants);

  // Pre-fetch categories referenced by hints to evaluate isOther.
  const hintCategoryIds = [...new Set(Array.from(historyHints.values()).map((h) => h.categoryId))];
  const hintCategories = hintCategoryIds.length === 0 ? [] : await prisma.category.findMany({
    where: { id: { in: hintCategoryIds }, archivedAt: null },
    select: { id: true, name: true, archivedAt: true },
  });
  const hintCatById = new Map(hintCategories.map((c) => [c.id, c]));

  const stillUnmapped: Loaded[] = [];
  for (const t of unmapped) {
    const hint = historyHints.get(t.merchantNormalized);
    const hintCat = hint ? hintCatById.get(hint.categoryId) : undefined;
    if (!hint || !hintCat) { stillUnmapped.push(t); continue; }

    const isOther = isOtherCategory({ name: hintCat.name, archivedAt: hintCat.archivedAt });
    const needsConfirmation = computeNeedsConfirmation({
      mode,
      source: "history",
      isOther,
      priorNeedsConfirmation: hint.needsConfirmation,
    });
    const dismissedUntil = hint.dismissedUntil && hint.dismissedUntil.getTime() > Date.now() ? hint.dismissedUntil : null;

    // Atomic guard preserved (categoryId IS NULL AND source IS NULL).
    await prisma.transactionAllocation.updateMany({
      where: { id: t.allocationId, categoryId: null, source: null },
      data: { categoryId: hint.categoryId, source: "history", needsConfirmation, dismissedUntil },
    });
    emitCategorizeCompleted({
      workspaceId,
      source: "history",
      categoryName: hintCat.name,
      pfcPrimary: null,
      pfcConfidence: null,
      pfcMissing: true,
    });
  }
  if (stillUnmapped.length === 0) return;

  // Step 3: LLM batch. Build workspace-scoped active category map.
  const categoryRows = await prisma.category.findMany({
    where: { workspaceId, archivedAt: null },
    select: { id: true, name: true },
  });
  const categoryByLower = new Map(categoryRows.map((c) => [c.name.toLowerCase(), c.id]));
  const categoryNames = categoryRows.map((c) => c.name);
  if (categoryNames.length === 0) return; // no vocabulary, nothing to do

  const batchMax = env.CATEGORIZE_BATCH_MAX ?? 50; // optional field; default in code not zod
  for (let i = 0; i < stillUnmapped.length; i += batchMax) {
    const batch = stillUnmapped.slice(i, i + batchMax);
    const llmTxs: LLMTransaction[] = batch.map((t) => {
      const pfcRaw = (t.rawData as { personal_finance_category?: { primary?: string; detailed?: string; confidence_level?: string } } | null)?.personal_finance_category;
      const pfc = pfcRaw?.primary
        ? { primary: pfcRaw.primary, detailed: pfcRaw.detailed ?? "", confidence: pfcRaw.confidence_level ?? "LOW" }
        : undefined;
      return {
        id: t.id,
        merchantRaw: t.merchantRaw,
        amount: t.amount,
        occurredAtISO: t.occurredAt.toISOString().slice(0, 10),
        ...(pfc ? { pfc } : {}),
      };
    });

    let results: Array<{ tx_id: string; category: string }> = [];
    try {
      results = await callGeminiCategorize(env, categoryNames, llmTxs);
    } catch (e) {
      // Log + continue. Tx in this batch stay uncategorized.
      // NOTE: callGeminiCategorize may throw on network errors OR on
      // JSON.parse failure (malformed structured response). Both are caught
      // here so the "best-effort, leave uncategorized" contract holds.
      logError({ workspaceId, err: e }, "[categorize] Gemini batch failed");
      continue;
    }

    const batchIdSet = new Set(batch.map((t) => t.id));
    for (const r of results) {
      if (!batchIdSet.has(r.tx_id)) continue;
      // Guard against malformed rows where category is null/undefined — calling
      // .toLowerCase() on those would throw and violate the best-effort contract.
      if (typeof r.category !== "string") continue;
      const aiCatId = categoryByLower.get(r.category.toLowerCase());
      if (!aiCatId) continue;

      // Step 3: Gemini results — write to the single null-cat allocation per tx
      // via per-row guard. Skip tx that are already split or already categorized.
      const tx = await prisma.transaction.findFirst({
        where: { id: r.tx_id, workspaceId },
        include: { allocations: { select: { id: true, categoryId: true, source: true } } },
      });
      if (!tx || tx.allocations.length !== 1) continue;
      const a = tx.allocations[0]!;
      if (a.categoryId !== null || a.source !== null) continue;

      const aiCat = await prisma.category.findUnique({
        where: { id: aiCatId },
        select: { name: true, archivedAt: true },
      });
      const isOther = aiCat ? isOtherCategory({ name: aiCat.name, archivedAt: aiCat.archivedAt }) : false;
      const needsConfirmation = computeNeedsConfirmation({ mode, source: "ai", isOther, priorNeedsConfirmation: null });

      const upd = await prisma.transactionAllocation.updateMany({
        where: { id: a.id, categoryId: null, source: null },
        data: { categoryId: aiCatId, source: "ai", needsConfirmation, dismissedUntil: null },
      });
      if (upd.count > 0) {
        const pfcSource = batch.find((bt) => bt.id === r.tx_id);
        const pfcRaw = (pfcSource?.rawData as { personal_finance_category?: { primary?: string; confidence_level?: string } } | null | undefined)?.personal_finance_category;
        emitCategorizeCompleted({
          workspaceId,
          source: "ai",
          categoryName: aiCat?.name ?? "?",
          pfcPrimary: pfcRaw?.primary ?? null,
          pfcConfidence: pfcRaw?.confidence_level ?? null,
          pfcMissing: !pfcRaw?.primary,
        });
      }
    }
  }
}
