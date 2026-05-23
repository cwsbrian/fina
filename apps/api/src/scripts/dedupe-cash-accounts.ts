/**
 * One-shot cleanup: collapse duplicate manual-account names within a
 * workspace (case-insensitive). Keeps the oldest row and re-points any
 * transactions on dupes to the keeper. Reports rows touched.
 *
 *   pnpm tsx src/scripts/dedupe-cash-accounts.ts
 */
import { prisma } from "../db.js";

type Row = { id: string; workspaceId: string; name: string; createdAt: Date };

async function main(): Promise<void> {
  const rows: Row[] = await prisma.bankAccount.findMany({
    where: { plaidAccountId: null, archivedAt: null },
    select: { id: true, workspaceId: true, name: true, createdAt: true },
    orderBy: [{ workspaceId: "asc" }, { createdAt: "asc" }],
  });
  // Group by (workspaceId, lower(name)). The first row in each group
  // is the keeper; the rest get repointed + deleted.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.workspaceId}::${r.name.toLowerCase()}`;
    const arr = groups.get(k) ?? [];
    arr.push(r);
    groups.set(k, arr);
  }

  let collapsed = 0;
  let txMoved = 0;
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const [keeper, ...dupes] = group;
    if (!keeper) continue;
    const dupeIds = dupes.map((d) => d.id);
    const upd = await prisma.transaction.updateMany({
      where: { accountId: { in: dupeIds } },
      data: { accountId: keeper.id },
    });
    txMoved += upd.count;
    const del = await prisma.bankAccount.deleteMany({
      where: { id: { in: dupeIds } },
    });
    collapsed += del.count;
    console.log(`  ${key}: kept ${keeper.id}, deleted ${dupeIds.length}, ${upd.count} tx moved`);
  }
  console.log(`Done. Collapsed ${collapsed} dup account(s); moved ${txMoved} tx.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
