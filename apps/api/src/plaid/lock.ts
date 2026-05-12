import type { Prisma } from "@prisma/client";
import { HttpError } from "../auth/context.js";

export class SyncLockHeld extends Error {
  constructor() {
    super("plaid_item is locked by another sync/disconnect");
  }
}

/**
 * Acquire a non-blocking row-level lock on the plaid_items row inside a
 * Prisma transaction. Three outcomes:
 *
 *   1. Row exists + free  → returns; lock is held until tx commits.
 *   2. Row exists + held  → Postgres raises SQLSTATE 55P03 ("could not
 *      obtain lock") immediately; we surface as `SyncLockHeld` so the
 *      caller can decide (sync returns `{skipped:"lock_held"}`, disconnect
 *      throws 409 `sync_in_progress`).
 *   3. Row vanished       → SELECT returns 0 rows. We surface as 404
 *      `not_found` so concurrent disconnect+refresh races don't get a
 *      misleading `502 plaid_unavailable` later (`Prisma P2025` would
 *      bubble up as an unhandled error otherwise).
 */
export async function lockPlaidItem(
  tx: Prisma.TransactionClient,
  plaidItemId: string,
): Promise<void> {
  let rows: { id: string }[];
  try {
    rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "plaid_items" WHERE id = ${plaidItemId} FOR UPDATE NOWAIT
    `;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "55P03" || /could not obtain lock/i.test((e as Error).message ?? "")) {
      throw new SyncLockHeld();
    }
    throw e;
  }
  if (rows.length === 0) {
    throw new HttpError(404, "not_found", "plaid_item vanished");
  }
}
