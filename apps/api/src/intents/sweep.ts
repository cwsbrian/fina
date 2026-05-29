import { prisma } from "../db.js";

/** Delete unconsumed ActionIntents whose TTL has passed. Consumed intents
 *  are kept (audit events reference them). Interactive read-tool cards
 *  (recurring_candidates, scheduled_list) pre-create intents eagerly, so
 *  this bounds the table. Returns the number deleted. */
export async function sweepExpiredIntents(): Promise<number> {
  const { count } = await prisma.actionIntent.deleteMany({
    where: { consumedAt: null, expiresAt: { lt: new Date() } },
  });
  return count;
}
