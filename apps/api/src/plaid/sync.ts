import { Prisma } from "@prisma/client";
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { plaidClient, isPlaidErrorCode, isPlaidApiError, sanitizePlaidError, mapPlaidError } from "./client.js";
import { readAccessToken } from "./items.js";
import { lockPlaidItem, SyncLockHeld } from "./lock.js";
import { HttpError } from "../auth/context.js";

// `skipped` carries the partial counters from any pages that DID commit
// before the lock was lost (final-tx race) — the page-level commits are
// real and the user can see them. So the skipped variant uses `number`,
// not literal 0. Routes that re-emit a "lock_held" response can still pass
// zero-counters at the boundary if they prefer; the type doesn't force it.
export type SyncResult =
  | { added: number; modified: number; removed: number; newTxIds: string[] }
  | { skipped: "lock_held"; added: number; modified: number; removed: number; newTxIds: string[] };

// Plan 1E-time: anchor date-only Plaid input at UTC noon so user-timezone
// day-boundary filters classify the row into the intended local day across
// UTC-11..+11 zones. ISO-8601 inputs (those containing 'T') are trusted as-is.
export function parsePlaidInstant(s: string): Date {
  if (s.includes("T")) return new Date(s);
  return new Date(`${s}T12:00:00.000Z`);
}

export function plaidOccurredAt(t: PlaidTxLike): Date {
  // Prefer authorized_* (when the user actually transacted), fall back to date.
  const v = t.authorized_datetime ?? t.authorized_date ?? t.datetime ?? t.date;
  if (!v) throw new Error(`Plaid transaction ${t.transaction_id} has no date field`);
  return new Date(v);
}

export function plaidPostedAt(t: PlaidTxLike): Date | null {
  if (t.pending) return null;
  const v = t.datetime ?? t.date;
  return new Date(v);
}

type PlaidTxLike = {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  authorized_date?: string | null;
  authorized_datetime?: string | null;
  datetime?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
  merchant_name?: string | null;
  name?: string | null;
  iso_currency_code?: string | null;
};

type PlaidPageData = {
  added: PlaidTxLike[];
  modified: PlaidTxLike[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
};

const MAX_MUTATION_RESTARTS = 3;

export async function syncTransactions(env: Env, workspaceId: string, plaidItemId: string): Promise<SyncResult> {
  // Read item once outside any tx so we have the original cursor even if the
  // first per-page lock attempt fails. No lock here — we don't need one to
  // simply read encrypted bytes + cursor for our own loop bookkeeping.
  const item = await prisma.plaidItem.findUnique({
    where: { id: plaidItemId },
    select: { workspaceId: true, lastCursor: true },
  });
  if (!item || item.workspaceId !== workspaceId) {
    throw new HttpError(404, "not_found", "plaid_item not found in workspace");
  }

  const { accessToken } = await readAccessToken(env, workspaceId, plaidItemId);
  const originalCursor = item.lastCursor ?? null;
  let cursor: string | null = originalCursor;
  let added = 0, modified = 0, removed = 0;
  const newTxIds: string[] = [];
  let restarts = 0;

  try {
    pageLoop: while (true) {
      let pageData: PlaidPageData;
      try {
        // Build the request body conditionally — under exactOptionalPropertyTypes
        // we can't pass `cursor: undefined` to a `cursor: string` field. Plaid
        // treats omitted cursor as "first sync from earliest available data".
        const req = cursor !== null
          ? { access_token: accessToken, cursor }
          : { access_token: accessToken };
        const res = await plaidClient(env).transactionsSync(req);
        pageData = res.data as PlaidPageData;
      } catch (e) {
        // Plaid emits TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION (an error
        // code) when the item changed mid-pagination. Per Plaid docs the
        // client must restart from the ORIGINAL cursor and discard whatever
        // partial state it had. Any committed page rows stay (they're still
        // valid Plaid state); the cursor in DB hasn't moved (we only commit
        // it at has_more=false) so the restart is naturally idempotent.
        if (isPlaidErrorCode(e, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")) {
          restarts++;
          if (restarts > MAX_MUTATION_RESTARTS) {
            // Pathological: the item is changing faster than we can read.
            // Surface as plaid_unavailable so client can back off.
            throw e;
          }
          cursor = originalCursor;
          added = modified = removed = 0;
          // NOTE: newTxIds is NOT reset — committed inserts from prior pages
          // are durable and need categorizing regardless of the restart.
          continue pageLoop;
        }
        throw e;
      }

      // Per-page tx: row-lock the plaid_items row + apply this page's
      // added/modified/removed. lastCursor + lastSyncAt are NOT updated here —
      // see the final-page tx after the loop. That way under any mid-loop
      // failure the next sync simply re-fetches from the original cursor;
      // partial-unique index makes the upserts idempotent.
      try {
        await prisma.$transaction(async (tx) => {
          await lockPlaidItem(tx, plaidItemId); // FOR UPDATE NOWAIT — throws SyncLockHeld if held
          for (const t of pageData.added) {
            const result = await upsertAdded(tx, t, plaidItemId, workspaceId);
            if (result.kind === "inserted") newTxIds.push(result.localId);
            added++;
          }
          for (const t of pageData.modified) { await upsertModified(tx, t, workspaceId); modified++; }
          for (const t of pageData.removed)  { await markRemoved(tx, t.transaction_id, workspaceId); removed++; }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (e) {
        if (e instanceof SyncLockHeld) {
          // Pass through whatever counters previous pages already committed
          // (the per-page tx is the unit of durability — earlier pages are
          // safely on disk even though this one rolled back). The route
          // returns the shape verbatim so the UI can show "got N before
          // yielding to another sync."
          return { skipped: "lock_held", added, modified, removed, newTxIds };
        }
        throw e;
      }

      cursor = pageData.next_cursor;
      if (!pageData.has_more) break;
    }

    // ---- Final tx: commit lastCursor + lastSyncAt + status=active ----
    // Same row lock as per-page so disconnect can't slip in here either.
    try {
      await prisma.$transaction(async (tx) => {
        await lockPlaidItem(tx, plaidItemId);
        await tx.plaidItem.update({
          where: { id: plaidItemId },
          data: { lastCursor: cursor, lastSyncAt: new Date(), status: "active", errorCode: null },
        });
      });
    } catch (e) {
      if (e instanceof SyncLockHeld) {
        return { skipped: "lock_held", added, modified, removed, newTxIds };
      }
      throw e;
    }

    return { added, modified, removed, newTxIds };
  } catch (e) {
    // Persist status in a SEPARATE short tx so it survives the rethrow.
    if (isPlaidErrorCode(e, "ITEM_LOGIN_REQUIRED")) {
      await prisma.plaidItem.update({
        where: { id: plaidItemId },
        data: { status: "relink_required", errorCode: "ITEM_LOGIN_REQUIRED" },
      });
      throw mapPlaidError(e); // 409 plaid_login_required
    }
    if (isPlaidApiError(e)) {
      const s = sanitizePlaidError(e);
      await prisma.plaidItem.update({
        where: { id: plaidItemId },
        data: { status: "error", errorCode: s.error_code ?? "unknown" },
      });
      throw mapPlaidError(e); // 502 plaid_unavailable
    }
    throw e;
  }
}

async function accountIdForPlaidAccount(
  tx: Prisma.TransactionClient,
  plaidItemId: string,
  plaidAccountId: string,
): Promise<string> {
  // Strict — the exchange handler must have created the bank_accounts row
  // for every Plaid `account_id` we'll see in transactions. If a transaction
  // arrives with an account_id we don't know, that's a bug we want to fail
  // loudly on (rather than silently quartering it on an unrelated account).
  // Tests must use the same plaidAccountId in their mock transactions as
  // they used in their account fixture.
  const acct = await tx.bankAccount.findFirstOrThrow({
    where: { plaidItemId, plaidAccountId },
    select: { id: true },
  });
  return acct.id;
}

export async function upsertAdded(
  tx: Prisma.TransactionClient,
  t: PlaidTxLike,
  plaidItemId: string,
  workspaceId: string,
): Promise<{ kind: "inserted" | "updated"; localId: string }> {
  // Promotion path: posted row points back at an existing pending row.
  if (t.pending_transaction_id) {
    const promotion = await tx.transaction.findFirst({
      where: {
        workspaceId,
        plaidTransactionId: t.pending_transaction_id, // OLD pending row's transaction_id
      },
      select: { id: true },
    });
    if (promotion) {
      await tx.transaction.update({
        where: { id: promotion.id },
        data: {
          plaidTransactionId: t.transaction_id,
          plaidPendingTransactionId: t.pending_transaction_id,
          pending: false,
          occurredAt: plaidOccurredAt(t),
          postedAt: plaidPostedAt(t),
          amount: t.amount,
          merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
          rawData: t as unknown as Prisma.InputJsonValue,
          removedAt: null, // promote restores any earlier soft-removal
        },
      });
      return { kind: "updated", localId: promotion.id };
    }
  }

  // Fresh-insert path: lookup-then-update-or-create by partial unique
  // (workspaceId, plaidTransactionId). We can't rely on `create` + catch
  // P2002: inside a Postgres transaction (esp. Serializable), a unique-
  // constraint violation aborts the surrounding tx ("current transaction is
  // aborted" / 25P02), so the fallback `updateMany` would fail. Doing the
  // existence check first keeps the tx healthy. Mutation-during-pagination
  // restart and webhook replay both rely on this idempotent behavior.
  const accountId = await accountIdForPlaidAccount(tx, plaidItemId, t.account_id);
  const existing = await tx.transaction.findFirst({
    where: { workspaceId, plaidTransactionId: t.transaction_id },
    select: { id: true },
  });
  if (existing) {
    await tx.transaction.update({
      where: { id: existing.id },
      data: {
        amount: t.amount,
        merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
        occurredAt: plaidOccurredAt(t),
        postedAt: plaidPostedAt(t),
        pending: t.pending,
        rawData: t as unknown as Prisma.InputJsonValue,
      },
    });
    return { kind: "updated", localId: existing.id };
  }
  const created = await tx.transaction.create({
    data: {
      workspaceId,
      accountId,
      plaidItemId,
      plaidTransactionId: t.transaction_id,
      plaidPendingTransactionId: t.pending_transaction_id ?? null,
      amount: t.amount,
      currency: t.iso_currency_code ?? "CAD",
      merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
      occurredAt: plaidOccurredAt(t),
      postedAt: plaidPostedAt(t),
      pending: t.pending,
      rawData: t as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return { kind: "inserted", localId: created.id };
}

export async function upsertModified(
  tx: Prisma.TransactionClient,
  t: PlaidTxLike,
  workspaceId: string,
): Promise<void> {
  await tx.transaction.updateMany({
    where: { workspaceId, plaidTransactionId: t.transaction_id },
    data: {
      amount: t.amount,
      merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
      occurredAt: plaidOccurredAt(t),
      postedAt: plaidPostedAt(t),
      pending: t.pending,
      rawData: t as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function markRemoved(
  tx: Prisma.TransactionClient,
  plaidTransactionId: string,
  workspaceId: string,
): Promise<void> {
  await tx.transaction.updateMany({
    where: { workspaceId, plaidTransactionId, removedAt: null },
    data: { removedAt: new Date() },
  });
}
