import { prisma } from "../../db.js";
import { matchScheduledSpends } from "../../schedules/match.js";
import type { Env } from "../../env.js";

/**
 * Iterate active workspaces and run match. Errors per workspace are caught
 * so one bad workspace doesn't stop the rest.
 */
export async function runScheduledSpendMatch(_env: Env): Promise<void> {
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  const today = new Date();
  let totalMatched = 0;
  let totalUnresolved = 0;
  for (const ws of workspaces) {
    try {
      const r = await matchScheduledSpends(ws.id, today);
      totalMatched += r.matched;
      totalUnresolved += r.unresolved;
    } catch (e) {
      console.error("scheduled-spend-match: workspace failed", { workspaceId: ws.id, err: e });
    }
  }
  console.info("scheduled-spend-match: complete", { totalMatched, totalUnresolved });
}
