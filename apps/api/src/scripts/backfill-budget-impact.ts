import { prisma } from "../db.js";
import { budgetImpactForAmount, classifyPlaidBudgetImpact } from "../transactions/budget-impact.js";

async function main(): Promise<void> {
  const rows = await prisma.transaction.findMany({
    where: { budgetImpactSource: "auto", removedAt: null },
    select: {
      id: true,
      workspaceId: true,
      accountId: true,
      amount: true,
      merchantRaw: true,
      occurredAt: true,
      source: true,
      rawData: true,
    },
  });

  let classified = 0;
  for (const row of rows) {
    const amount = Number(row.amount);
    const budgetImpact = row.source === "plaid"
      ? classifyPlaidBudgetImpact({
          amount,
          ...(row.rawData as object),
        })
      : budgetImpactForAmount(amount);
    const result = await prisma.transaction.updateMany({
      where: { id: row.id, budgetImpactSource: "auto" },
      data: { budgetImpact },
    });
    classified += result.count;
  }

  console.log(`backfill-budget-impact classified=${classified}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
