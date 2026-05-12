import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { normalizeMerchant } from "./normalize.js";
import { callGeminiCategorize, type LLMTransaction } from "./llm.js";

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
 * All writes guard by `categorizationSource IS NULL` to avoid overwriting a
 * manual decision that races with our LLM call.
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

  // Step 1: Load tx + populate merchantNormalized on each row.
  const txs = await prisma.transaction.findMany({
    where: { id: { in: newTxIds }, workspaceId, categoryId: null },
    select: {
      id: true,
      merchantRaw: true,
      merchantNormalized: true,
      amount: true,
      occurredAt: true,
    },
  });

  // Sort txs to match the caller-supplied newTxIds order so that batching is
  // deterministic (important when batchMax < total unmapped count).
  const txOrder = new Map(newTxIds.map((id, i) => [id, i]));
  const sortedTxs = [...txs].sort((a, b) => (txOrder.get(a.id) ?? 0) - (txOrder.get(b.id) ?? 0));

  type Loaded = { id: string; merchantRaw: string; merchantNormalized: string; amount: number; occurredAt: Date };
  const loaded: Loaded[] = [];
  for (const t of sortedTxs) {
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
      await prisma.transaction.updateMany({
        where: { id: t.id, workspaceId, categorizationSource: null },
        data: { categoryId: catId, categorizationSource: "mapping" },
      });
    } else {
      unmapped.push(t);
    }
  }
  if (unmapped.length === 0) return;

  // Step 3: LLM batch. Build workspace-scoped active category map.
  const categoryRows = await prisma.category.findMany({
    where: { workspaceId, archivedAt: null },
    select: { id: true, name: true },
  });
  const categoryByLower = new Map(categoryRows.map((c) => [c.name.toLowerCase(), c.id]));
  const categoryNames = categoryRows.map((c) => c.name);
  if (categoryNames.length === 0) return; // no vocabulary, nothing to do

  const batchMax = env.CATEGORIZE_BATCH_MAX ?? 50; // optional field; default in code not zod
  for (let i = 0; i < unmapped.length; i += batchMax) {
    const batch = unmapped.slice(i, i + batchMax);
    const llmTxs: LLMTransaction[] = batch.map((t) => ({
      id: t.id,
      merchantRaw: t.merchantRaw,
      amount: t.amount,
      occurredAtISO: t.occurredAt.toISOString().slice(0, 10),
    }));

    let results: Array<{ tx_id: string; category: string }> = [];
    try {
      results = await callGeminiCategorize(env, categoryNames, llmTxs);
    } catch (e) {
      // Log + continue. Tx in this batch stay uncategorized.
      // NOTE: callGeminiCategorize may throw on network errors OR on
      // JSON.parse failure (malformed structured response). Both are caught
      // here so the "best-effort, leave uncategorized" contract holds.
      console.error("[categorize] Gemini batch failed", e);
      continue;
    }

    const batchIdSet = new Set(batch.map((t) => t.id));
    for (const r of results) {
      if (!batchIdSet.has(r.tx_id)) continue;
      // Guard against malformed rows where category is null/undefined — calling
      // .toLowerCase() on those would throw and violate the best-effort contract.
      if (typeof r.category !== "string") continue;
      const catId = categoryByLower.get(r.category.toLowerCase());
      if (!catId) continue;
      await prisma.transaction.updateMany({
        where: { id: r.tx_id, workspaceId, categorizationSource: null },
        data: { categoryId: catId, categorizationSource: "ai" },
      });
    }
  }
}
