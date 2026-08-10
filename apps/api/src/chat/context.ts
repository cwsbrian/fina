import { prisma } from "../db.js";
import { todayKeyInTz } from "./tools/periods.js";

/** Financial + temporal context appended after the conversation history on
 *  every chat turn. The temporal line is non-negotiable now that recap tools
 *  accept since/until ISO date keys — the LLM needs an unambiguous
 *  "today" anchor in the user's timezone to translate "this month",
 *  "올해", "지난 90일" etc. into specific dates. */
export async function buildFinancialContext(
  workspaceId: string,
  userId: string,
): Promise<string> {
  const [workspace, txCount, latestTx, categoryCount, { today, tz }] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { currency: true },
    }),
    prisma.transaction.count({ where: { workspaceId, removedAt: null } }),
    prisma.transaction.findFirst({
      where: { workspaceId, removedAt: null },
      orderBy: { occurredAt: "desc" },
      select: { occurredAt: true },
    }),
    prisma.category.count({ where: { workspaceId, archivedAt: null } }),
    todayKeyInTz(userId),
  ]);
  const latestLine = latestTx
    ? `- Latest transaction date: ${latestTx.occurredAt.toISOString().slice(0, 10)}`
    : `- No transactions yet`;
  return [
    `## Current state`,
    `- Today: ${today} (timezone ${tz})`,
    `- Workspace currency: ${workspace.currency}`,
    `- Total transactions: ${txCount}`,
    latestLine,
    `- Categories defined: ${categoryCount}`,
  ].join("\n");
}
