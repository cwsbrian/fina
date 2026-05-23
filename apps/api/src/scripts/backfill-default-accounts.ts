/**
 * One-shot backfill: seed the default manual accounts into every workspace
 * that doesn't already have them. Idempotent — skipDuplicates means
 * pre-existing same-name accounts are left alone.
 *
 * Run from apps/api:
 *   pnpm tsx src/scripts/backfill-default-accounts.ts
 */
import { prisma } from "../db.js";
import { seedDefaultAccounts } from "../accounts/seed.js";

async function main(): Promise<void> {
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, currency: true },
  });
  console.log(`Backfilling ${workspaces.length} workspace(s)...`);
  let touched = 0;
  for (const w of workspaces) {
    const before = await prisma.bankAccount.count({
      where: { workspaceId: w.id, plaidAccountId: null },
    });
    await prisma.$transaction(async (tx) =>
      seedDefaultAccounts(tx, w.id, w.currency),
    );
    const after = await prisma.bankAccount.count({
      where: { workspaceId: w.id, plaidAccountId: null },
    });
    if (after > before) {
      console.log(`  ${w.id}: +${after - before} account(s)`);
      touched += after - before;
    }
  }
  console.log(`Done. Inserted ${touched} account row(s) total.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
