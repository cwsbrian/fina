/**
 * One-shot backfill: run the categorize pipeline against existing
 * uncategorized transactions (allocations with categoryId=null + source=null).
 *
 * Useful for testing the new history/needsConfirmation flow against real
 * data without waiting for a fresh Plaid sync.
 *
 * Run from apps/api:
 *   pnpm tsx src/scripts/backfill-categorize-uncategorized.ts
 */
import { prisma } from "../db.js";
import { categorizeNewTransactions } from "../categorize/service.js";
import type { Env } from "../env.js";

async function main(): Promise<void> {
  // Dev backfill: categorize service only uses GEMINI_API_KEY +
  // CATEGORIZE_BATCH_MAX. Skip the full env validation (Stripe/Plaid/etc
  // not needed here).
  const gemini = process.env.GEMINI_API_KEY;
  if (!gemini) {
    console.error("GEMINI_API_KEY is required (export it or source the root .env).");
    process.exit(1);
  }
  const env = { GEMINI_API_KEY: gemini, CATEGORIZE_BATCH_MAX: 50 } as unknown as Env;

  const uncategorized = await prisma.transaction.findMany({
    where: {
      removedAt: null,
      allocations: { some: { categoryId: null, source: null } },
    },
    select: { id: true, workspaceId: true },
  });

  if (uncategorized.length === 0) {
    console.log("No uncategorized transactions found.");
    return;
  }

  const byWorkspace = new Map<string, string[]>();
  for (const t of uncategorized) {
    const arr = byWorkspace.get(t.workspaceId) ?? [];
    arr.push(t.id);
    byWorkspace.set(t.workspaceId, arr);
  }
  console.log(`Found ${uncategorized.length} uncategorized tx across ${byWorkspace.size} workspaces.`);

  for (const [workspaceId, ids] of byWorkspace) {
    console.log(`  workspace ${workspaceId}: ${ids.length} tx → categorizing...`);
    await categorizeNewTransactions(env, workspaceId, ids);
  }

  const remaining = await prisma.transactionAllocation.count({
    where: { categoryId: null, source: null, transaction: { removedAt: null } },
  });
  const needsReview = await prisma.transactionAllocation.count({
    where: { needsConfirmation: true },
  });
  console.log(`Done. ${remaining} allocations still uncategorized; ${needsReview} now flagged needsConfirmation=true.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
