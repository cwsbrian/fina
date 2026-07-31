import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { encrypt, decrypt } from "../crypto/aes-gcm.js";
import { plaidClient, mapPlaidError, isPlaidErrorCode } from "./client.js";
import { HttpError } from "../auth/context.js";
import { lockPlaidItem, SyncLockHeld } from "./lock.js";

export type StoreInput = {
  workspaceId: string;
  connectedBy?: string | null; // userId of the member who initiated the Plaid Link flow
  itemId: string;
  institutionId: string;
  institutionName: string;
  accessToken: string; // raw — only here briefly before encryption
  webhookUrl?: string | null; // NEW — set at connect time, skips startup backfill for this item
};

/**
 * Encrypt + create the plaid_items row. Caller wraps in $transaction with the
 * accounts.createMany so item + accounts commit together.
 *
 * @returns the created plaid_items row id.
 */
export async function storeAccessToken(
  env: Env,
  tx: Pick<typeof prisma, "plaidItem">,
  input: StoreInput,
): Promise<string> {
  const { ciphertext, iv } = encrypt(env, input.accessToken, input.workspaceId);
  const created = await tx.plaidItem.create({
    data: {
      workspaceId: input.workspaceId,
      ...(input.connectedBy != null ? { connectedBy: input.connectedBy } : {}),
      itemId: input.itemId,
      institutionId: input.institutionId,
      institutionName: input.institutionName,
      accessTokenCiphertext: ciphertext,
      accessTokenIv: iv,
      ...(input.webhookUrl != null ? { webhookUrl: input.webhookUrl } : {}),
    },
  });
  return created.id;
}

/**
 * Look up by (workspaceId, plaidItemId), verify ownership, decrypt. Per master
 * spec §10.1 hard rule #4 — Plaid call functions take BOTH args and verify
 * inside.
 *
 * Throws 404 not_found if either id doesn't match.
 */
export async function readAccessToken(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
): Promise<{ accessToken: string; itemRow: { id: string; itemId: string } }> {
  const row = await prisma.plaidItem.findUnique({
    where: { id: plaidItemId },
    select: {
      id: true,
      workspaceId: true,
      itemId: true,
      accessTokenCiphertext: true,
      accessTokenIv: true,
    },
  });
  if (!row || row.workspaceId !== workspaceId) {
    throw new HttpError(404, "not_found", "plaid_item not found in workspace");
  }
  const accessToken = decrypt(env, row.accessTokenCiphertext, row.accessTokenIv, workspaceId);
  return { accessToken, itemRow: { id: row.id, itemId: row.itemId } };
}

/**
 * Strict disconnect: Plaid /item/remove must succeed (or report ITEM_NOT_FOUND
 * = already removed) before the local row is touched. On other Plaid failures,
 * leave the row + encrypted token alone and surface 502 plaid_unavailable so
 * the caller can retry.
 *
 * On success: archive the accounts (archivedAt = now) and delete the plaid_item;
 * accounts.plaidItemId becomes NULL via the SetNull FK; transactions stay
 * (their plaidItemId also becomes NULL via SetNull).
 *
 * Lock contract (architecture §): the entire operation runs inside one tx
 * that takes the same `SELECT ... FOR UPDATE NOWAIT` row lock as the sync
 * page-tx, so a refresh in flight cannot apply a page mid-disconnect (and
 * vice-versa). The Plaid HTTP call happens inside the tx — disconnect is
 * a rare, user-initiated action so holding the row lock for the few seconds
 * of the Plaid round-trip is acceptable. If the lock is contended we throw
 * `409 sync_in_progress` so the caller can retry.
 */
export async function removeItemStrict(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
  opts: { deleteTransactions?: boolean } = {},
): Promise<void> {
  const { accessToken } = await readAccessToken(env, workspaceId, plaidItemId);

  try {
    // Prisma's interactive-tx default timeout is 5s — well under what a slow
    // Plaid `/item/remove` can take. Bump to 35s (Plaid SDK's own timeout
    // ceiling is ~30s) so a slow remote-remove doesn't leave us in the worst
    // failure mode: Plaid removed the item, then our cleanup tx aborts on
    // timeout and leaves a stale local row whose access_token is now invalid.
    // (That state IS retry-recoverable — a follow-up disconnect call will hit
    // ITEM_NOT_FOUND and clean up — but better to avoid it.)
    await prisma.$transaction(
      async (tx) => {
        await lockPlaidItem(tx, plaidItemId); // throws SyncLockHeld on 55P03
        const item = await tx.plaidItem.findUniqueOrThrow({
          where: { id: plaidItemId },
          select: { institutionId: true },
        });
        try {
          await plaidClient(env).itemRemove({ access_token: accessToken });
        } catch (e) {
          if (isPlaidErrorCode(e, "ITEM_NOT_FOUND")) {
            // Already removed remotely. Continue with local cleanup.
          } else {
            throw mapPlaidError(e); // 502 plaid_unavailable etc.
          }
        }
        await tx.bankAccount.updateMany({
          where: { plaidItemId },
          data: {
            archivedAt: new Date(),
            plaidInstitutionId: item.institutionId,
            plaidReconnectRequired: false,
          },
        });
        if (opts.deleteTransactions === true) {
          await tx.transaction.deleteMany({ where: { workspaceId, plaidItemId } });
        } else {
          // Grace imports were never visible and cannot be restored after the
          // user intentionally removes the owning Plaid Item.
          await tx.transaction.deleteMany({
            where: { workspaceId, plaidItemId, billingGraceHiddenAt: { not: null } },
          });
        }
        await tx.plaidItem.delete({ where: { id: plaidItemId } });
      },
      { maxWait: 5_000, timeout: 35_000 },
    );
  } catch (e) {
    if (e instanceof SyncLockHeld) {
      throw new HttpError(409, "sync_in_progress", "another sync or disconnect is in progress");
    }
    throw e;
  }
}

/**
 * Billing-side disconnect: calls Plaid /item/remove to stop recurring charges,
 * archives linked accounts, then deletes the local Plaid item and encrypted
 * access token. Historical transactions remain and their Plaid FK becomes
 * NULL via SetNull.
 *
 * Uses the same Plaid item row lock as sync so a billing cleanup cannot race
 * an in-flight sync that would otherwise mark the item active again.
 *
 * Partial-failure retry: if the Plaid call succeeds but local deletion fails,
 * the item stays 'active'. Tomorrow's Step 0 retries, Plaid returns
 * ITEM_NOT_FOUND, the catch falls through, and the DB update succeeds.
 */
export async function removeItemForBilling(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
  opts: {
    reconnectRequired?: boolean;
    deleteGraceHiddenTransactions?: boolean;
  } = {},
): Promise<void> {
  const { accessToken } = await readAccessToken(env, workspaceId, plaidItemId);

  await prisma.$transaction(
    async (tx) => {
      await lockPlaidItem(tx, plaidItemId);
      const item = await tx.plaidItem.findUniqueOrThrow({
        where: { id: plaidItemId },
        select: { institutionId: true },
      });

      try {
        await plaidClient(env).itemRemove({ access_token: accessToken });
      } catch (e) {
        if (isPlaidErrorCode(e, "ITEM_NOT_FOUND")) {
          // Already removed on Plaid's side — proceed with local cleanup.
        } else {
          throw e; // caller logs and continues to next item
        }
      }

      await tx.bankAccount.updateMany({
        where: { plaidItemId },
        data: {
          archivedAt: new Date(),
          plaidInstitutionId: item.institutionId,
          plaidReconnectRequired: opts.reconnectRequired ?? true,
        },
      });
      if (opts.deleteGraceHiddenTransactions === true) {
        await tx.transaction.deleteMany({
          where: { plaidItemId, billingGraceHiddenAt: { not: null } },
        });
      }
      await tx.plaidItem.delete({ where: { id: plaidItemId } });
    },
    { maxWait: 5_000, timeout: 35_000 },
  );
}
