import { Prisma } from "@prisma/client";

/**
 * Clear matchedTxId on any ScheduledSpend that referenced the given tx id.
 * Called when a tx is soft-removed (removedAt set). MUST be invoked from
 * inside a Prisma $transaction or workspace lock so reads+writes are atomic.
 */
export async function clearScheduleMatch(
  tx: Prisma.TransactionClient,
  txId: string,
): Promise<void> {
  await tx.scheduledSpend.updateMany({
    where: { matchedTxId: txId },
    data: { matchedTxId: null },
  });
}
