import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { budgetImpactForAmount, classifyPlaidBudgetImpact } from "../transactions/budget-impact.js";

function rawName(raw: unknown, fallback: string): string {
  return typeof raw === "object" && raw !== null && "name" in raw && typeof raw.name === "string"
    ? raw.name
    : fallback;
}

function isOwnTransferName(name: string): boolean {
  return /\bTFR-(TO|FR)\b/i.test(name);
}

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

  let transfers = 0;
  for (const row of rows) {
    if (row.amount.lte(0)) continue;
    if (!isOwnTransferName(rawName(row.rawData, row.merchantRaw))) continue;

    const dayStart = new Date(row.occurredAt);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const match = await prisma.transaction.findFirst({
      where: {
        workspaceId: row.workspaceId,
        accountId: { not: row.accountId },
        removedAt: null,
        amount: new Prisma.Decimal(row.amount).negated(),
        occurredAt: { gte: dayStart, lt: dayEnd },
        rawData: {
          path: ["personal_finance_category", "detailed"],
          equals: "TRANSFER_IN_ACCOUNT_TRANSFER",
        },
      },
      select: { id: true },
    });
    if (!match) continue;

    const result = await prisma.transaction.updateMany({
      where: { id: row.id, budgetImpactSource: "auto" },
      data: { budgetImpact: "excluded" },
    });
    transfers += result.count;
  }

  console.log(`backfill-budget-impact classified=${classified} ownTransfersExcluded=${transfers}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
