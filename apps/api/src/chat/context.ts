import { prisma } from "../db.js";

export async function buildFinancialContext(workspaceId: string): Promise<string> {
  const [txCount, latestTx, categoryCount] = await Promise.all([
    prisma.transaction.count({ where: { workspaceId, removedAt: null } }),
    prisma.transaction.findFirst({ where: { workspaceId, removedAt: null }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
    prisma.category.count({ where: { workspaceId, archivedAt: null } }),
  ]);
  const latestLine = latestTx ? `- Latest transaction date: ${latestTx.occurredAt.toISOString().slice(0, 10)}` : `- No transactions yet`;
  return [`## Current state`, `- Total transactions: ${txCount}`, latestLine, `- Categories defined: ${categoryCount}`].join("\n");
}
