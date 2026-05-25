import { prisma } from "../../db.js";
import { logInfo, logError } from "../../logger.js";
import type { Env } from "../../env.js";
import { sendGoalMilestonePush } from "../../push/send.js";
import { computeGoalSavings } from "../../goals/savings.js";

const MILESTONES = [100, 75, 50, 25] as const;
const CRON_NAME = "goal-milestones";

/** Daily cron. For every active goal, recompute saved-so-far and check
 *  whether it has crossed a 25/50/75/100% milestone since the last
 *  push. `Goal.lastMilestonePct` records the highest milestone already
 *  notified, so dips back below the line never re-fire. Push goes to
 *  every owner/editor of the workspace. */
export async function runGoalMilestones(env: Env): Promise<void> {
  const goals = await prisma.goal.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      title: true,
      targetAmount: true,
      workspaceId: true,
      lastMilestonePct: true,
    },
  });
  if (goals.length === 0) return;

  for (const g of goals) {
    try {
      const target = Number(g.targetAmount);
      if (target <= 0) continue;
      const saved = await computeGoalSavings(g.workspaceId, g.id);
      const pct = Math.min(100, Math.round((saved / target) * 100));
      const crossed = MILESTONES.find((m) => pct >= m);
      if (crossed === undefined) continue;
      const previous = g.lastMilestonePct ?? 0;
      if (crossed <= previous) continue; // already notified

      const memberships = await prisma.membership.findMany({
        where: { workspaceId: g.workspaceId, role: { in: ["owner", "editor"] } },
        select: { userId: true },
      });
      for (const m of memberships) {
        await sendGoalMilestonePush(env, m.userId, g.title, crossed);
      }
      await prisma.goal.update({
        where: { id: g.id },
        data: { lastMilestonePct: crossed },
      });
      logInfo(
        { cron: CRON_NAME, goalId: g.id, pct: crossed },
        "goal-milestone push sent",
      );
    } catch (err) {
      logError(
        { cron: CRON_NAME, goalId: g.id, err },
        "goal-milestone push failed",
      );
    }
  }
}
