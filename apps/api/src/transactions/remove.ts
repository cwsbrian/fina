import { withWorkspaceLock } from "../locks/workspace.js";

export type RemoveTxResult =
  | { removed: true }
  | { removed: false; alreadyRemoved: true };

export type RemoveTxErrorCode = "not_found" | "cannot_delete_pending";

export class RemoveTxError extends Error {
  readonly code: RemoveTxErrorCode;
  constructor(code: RemoveTxErrorCode) {
    super(code);
    this.name = "RemoveTxError";
    this.code = code;
  }
}

export async function removeTransactionService(
  ctx: { workspaceId: string },
  txId: string,
): Promise<RemoveTxResult> {
  return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const row = await tx.transaction.findFirst({
      where: { id: txId, workspaceId: ctx.workspaceId },
      select: { id: true, pending: true, plaidTransactionId: true, removedAt: true },
    });
    if (!row) throw new RemoveTxError("not_found");

    // ORDER MATTERS: pending-gate runs BEFORE idempotency check. A tx that
    // was already soft-removed by Plaid's markRemoved on page N can be
    // resurrected by a pending→posted promotion on page N+1
    // (sync.ts:235 unconditionally clears removedAt). Returning idempotent
    // 200 here would silently miss the resurrection — reject pending Plaid
    // tx regardless of current removedAt state. Manual tx (plaidTransactionId
    // === null) can never satisfy this gate.
    if (row.pending === true && row.plaidTransactionId !== null) {
      throw new RemoveTxError("cannot_delete_pending");
    }

    if (row.removedAt !== null) {
      return { removed: false, alreadyRemoved: true } as const;
    }

    await tx.transaction.update({
      where: { id: txId },
      data: { removedAt: new Date() },
    });
    return { removed: true } as const;
  });
}
