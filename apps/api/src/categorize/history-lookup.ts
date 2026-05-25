import { prisma } from "../db.js";

export type HistoryHint = {
  categoryId: string;
  needsConfirmation: boolean;
  /** Future ISO datetime, or null if not snoozed or expired. */
  dismissedUntil: Date | null;
};

/** For each `merchantNormalized` in input, return the most-recent eligible
 *  history hint in the workspace. Eligible means:
 *   - tx.removedAt is null
 *   - tx has exactly one allocation (no splits)
 *   - allocation.categoryId is not null
 *   - the referenced category is not archived
 *  Tiebreaker for equal occurredAt: smaller tx.id (deterministic). */
export async function findHistoryHints(
  workspaceId: string,
  merchantsNormalized: string[],
): Promise<Map<string, HistoryHint>> {
  if (merchantsNormalized.length === 0) return new Map();

  const rows = await prisma.$queryRaw<Array<{
    merchantNormalized: string;
    categoryId: string;
    needsConfirmation: boolean;
    dismissedUntil: Date | null;
  }>>`
    WITH ranked AS (
      SELECT
        t."merchantNormalized" AS "merchantNormalized",
        a."categoryId"          AS "categoryId",
        a."needsConfirmation"   AS "needsConfirmation",
        a."dismissedUntil"      AS "dismissedUntil",
        ROW_NUMBER() OVER (
          PARTITION BY t."merchantNormalized"
          ORDER BY t."occurredAt" DESC, t."id" ASC
        ) AS rn
      FROM "transactions" t
      JOIN "transaction_allocations" a ON a."transactionId" = t."id"
      JOIN "categories" c              ON c."id" = a."categoryId"
      WHERE t."workspaceId" = ${workspaceId}
        AND t."merchantNormalized" = ANY(${merchantsNormalized}::text[])
        AND t."removedAt" IS NULL
        AND a."categoryId" IS NOT NULL
        AND c."archivedAt" IS NULL
        AND (SELECT COUNT(*) FROM "transaction_allocations" x WHERE x."transactionId" = t."id") = 1
    )
    SELECT "merchantNormalized", "categoryId", "needsConfirmation", "dismissedUntil"
    FROM ranked WHERE rn = 1
  `;

  const out = new Map<string, HistoryHint>();
  for (const r of rows) {
    out.set(r.merchantNormalized, {
      categoryId: r.categoryId,
      needsConfirmation: r.needsConfirmation,
      dismissedUntil: r.dismissedUntil,
    });
  }
  return out;
}
