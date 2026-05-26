import { prisma } from "../db.js";
import { logError } from "../logger.js";
import type { Env } from "../env.js";
import { sendTransactionAddedPush } from "./send.js";

/** Notify every workspace member that a new transaction landed.
 *  When `excludeUserId` is provided (manual creation: the actor already
 *  knows), that member is skipped. Each recipient's prefs are
 *  independently checked inside the sender. Best-effort — errors are
 *  logged, never thrown. */
export async function notifyTransactionAdded(
  env: Env,
  args: {
    workspaceId: string;
    merchant: string;
    amount: number;
    categoryName: string | null;
    excludeUserId?: string;
  },
): Promise<void> {
  try {
    const members = await prisma.membership.findMany({
      where: { workspaceId: args.workspaceId },
      select: { userId: true },
    });
    for (const m of members) {
      if (args.excludeUserId && m.userId === args.excludeUserId) continue;
      try {
        await sendTransactionAddedPush(
          env,
          m.userId,
          args.merchant,
          args.amount.toFixed(2),
          args.categoryName,
        );
      } catch (err) {
        logError(
          { workspaceId: args.workspaceId, recipientUserId: m.userId, err },
          "transaction-added push to recipient failed",
        );
      }
    }
  } catch (err) {
    logError(
      { workspaceId: args.workspaceId, err },
      "transaction-added push fan-out failed",
    );
  }
}
