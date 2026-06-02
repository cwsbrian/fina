import { Prisma } from "@prisma/client";
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { plaidClient, isPlaidErrorCode, isPlaidApiError, sanitizePlaidError, mapPlaidError } from "./client.js";
import { readAccessToken } from "./items.js";
import { lockPlaidItem, SyncLockHeld } from "./lock.js";
import { HttpError } from "../auth/context.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import { clearScheduleMatch } from "../schedules/cleanup.js";
import { logWarn } from "../logger.js";
import { normalizeMerchant } from "../categorize/normalize.js";

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
  return parsePlaidInstant(v);
}

export function plaidPostedAt(t: PlaidTxLike): Date | null {
  if (t.pending) return null;
  const v = t.datetime ?? t.date;
  return parsePlaidInstant(v);
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

async function requireSyncablePlaidItem(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  plaidItemId: string,
): Promise<{ lastCursor: string | null }> {
  await lockPlaidItem(tx, plaidItemId);
  const item = await tx.plaidItem.findUnique({
    where: { id: plaidItemId },
    select: { workspaceId: true, status: true, lastCursor: true },
  });
  if (!item || item.workspaceId !== workspaceId || item.status === "disconnected") {
    throw new HttpError(404, "not_found", "plaid_item not found in workspace");
  }
  return { lastCursor: item.lastCursor ?? null };
}

export async function syncTransactions(env: Env, workspaceId: string, plaidItemId: string): Promise<SyncResult> {
  let preflight: { lastCursor: string | null };
  try {
    preflight = await prisma.$transaction((tx) =>
      requireSyncablePlaidItem(tx, workspaceId, plaidItemId),
    );
  } catch (e) {
    if (e instanceof SyncLockHeld) {
      return { skipped: "lock_held", added: 0, modified: 0, removed: 0, newTxIds: [] };
    }
    throw e;
  }

  const { accessToken } = await readAccessToken(env, workspaceId, plaidItemId);
  const originalCursor = preflight.lastCursor;
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
        await withWorkspaceLock(workspaceId, async (tx) => {
          await requireSyncablePlaidItem(tx, workspaceId, plaidItemId);
          for (const t of pageData.added) {
            const result = await upsertAdded(tx, t, plaidItemId, workspaceId);
            if (result.kind === "inserted") newTxIds.push(result.localId);
            added++;
          }
          for (const t of pageData.modified) { await upsertModified(tx, t, workspaceId); modified++; }
          for (const t of pageData.removed)  { await markRemoved(tx, t.transaction_id, workspaceId); removed++; }
        });
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
        await requireSyncablePlaidItem(tx, workspaceId, plaidItemId);
        await tx.plaidItem.updateMany({
          where: { id: plaidItemId, status: { not: "disconnected" } },
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
      await prisma.plaidItem.updateMany({
        where: { id: plaidItemId, status: { not: "disconnected" } },
        data: { status: "relink_required", errorCode: "ITEM_LOGIN_REQUIRED" },
      });
      throw mapPlaidError(e); // 409 plaid_login_required
    }
    if (isPlaidApiError(e)) {
      const s = sanitizePlaidError(e);
      await prisma.plaidItem.updateMany({
        where: { id: plaidItemId, status: { not: "disconnected" } },
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

async function disconnectedAccountMatch(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  currentAccount: {
    id: string;
    mask: string | null;
    type: string;
    subtype: string | null;
    currency: string;
    plaidItem: { institutionId: string } | null;
  },
): Promise<string | null> {
  if (!currentAccount.plaidItem || !currentAccount.mask) return null;
  const matches = await tx.bankAccount.findMany({
    where: {
      workspaceId,
      archivedAt: { not: null },
      mask: currentAccount.mask,
      type: currentAccount.type,
      subtype: currentAccount.subtype,
      currency: currentAccount.currency,
      plaidItem: { is: { institutionId: currentAccount.plaidItem.institutionId, status: "disconnected" } },
    },
    select: { id: true },
    take: 2,
  });
  return matches.length === 1 ? matches[0]!.id : null;
}

function plaidMerchantRaw(t: PlaidTxLike): string {
  return t.merchant_name ?? t.name ?? "Unknown";
}

function plaidReconnectMerchantRaw(t: PlaidTxLike): string | null {
  const merchantName = t.merchant_name?.trim();
  if (merchantName) return merchantName;
  const name = t.name?.trim();
  return name || null;
}

function candidateReconnectMerchantNormalized(candidate: {
  merchantRaw: string;
  merchantNormalized: string | null;
}): string | null {
  const raw = candidate.merchantRaw.trim();
  if (!raw || raw.toLowerCase() === "unknown") return null;
  const normalized = candidate.merchantNormalized?.trim();
  return normalized ? normalized : normalizeMerchant(candidate.merchantRaw);
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
      include: { allocations: { select: { id: true } } },
    });
    if (promotion) {
      const newAmount = new Prisma.Decimal(t.amount);
      // Paranoid check: pending tx must have N=1 allocation (cannot_split_pending
      // blocks user splits). If N != 1, log + skip the allocation update.
      if (promotion.allocations.length === 1) {
        await tx.transactionAllocation.update({
          where: { id: promotion.allocations[0]!.id },
          data: { amount: newAmount },
        });
      } else {
        logWarn(
          {},
          `plaid sync promotion: unexpected allocation count txId=${promotion.id} count=${promotion.allocations.length}`,
        );
      }
      await tx.transaction.update({
        where: { id: promotion.id },
        data: {
          plaidTransactionId: t.transaction_id,
          plaidPendingTransactionId: t.pending_transaction_id,
          pending: false,
          occurredAt: plaidOccurredAt(t),
          postedAt: plaidPostedAt(t),
          amount: newAmount,
          merchantRaw: plaidMerchantRaw(t),
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
    include: { allocations: { select: { id: true, amount: true } } },
  });
  if (existing) {
    const newAmount = new Prisma.Decimal(t.amount);
    const amountChanged = !existing.amount.equals(newAmount);
    const N = existing.allocations.length;

    // Preserve allocation invariant: sum(allocations.amount) == tx.amount.
    // N=1 + amount changed → update the single allocation amount.
    // N≥2 + amount changed → invalidate (defensive: in practice cannot_split_pending
    // blocks user splits on pending so replay should always be N=1, but guard anyway).
    if (amountChanged) {
      if (N === 1) {
        await tx.transactionAllocation.update({
          where: { id: existing.allocations[0]!.id },
          data: { amount: newAmount },
        });
      } else if (N >= 2) {
        await tx.transactionAllocation.deleteMany({ where: { transactionId: existing.id } });
        await tx.transactionAllocation.create({
          data: { transactionId: existing.id, categoryId: null, amount: newAmount, source: null },
        });
      }
    }
    await tx.transaction.update({
      where: { id: existing.id },
      data: {
        amount: newAmount,
        merchantRaw: plaidMerchantRaw(t),
        occurredAt: plaidOccurredAt(t),
        postedAt: plaidPostedAt(t),
        pending: t.pending,
        rawData: t as unknown as Prisma.InputJsonValue,
        ...(amountChanged && N >= 2 ? { needsReclassification: true } : {}),
      },
    });
    return { kind: "updated", localId: existing.id };
  }
  const currentAccount = await tx.bankAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      id: true,
      mask: true,
      type: true,
      subtype: true,
      currency: true,
      plaidItem: { select: { institutionId: true } },
    },
  });
  const oldAccountId = await disconnectedAccountMatch(tx, workspaceId, currentAccount);
  if (oldAccountId) {
    const reconnectMerchantRaw = plaidReconnectMerchantRaw(t);
    const merchantNormalized = reconnectMerchantRaw ? normalizeMerchant(reconnectMerchantRaw) : "";
    if (merchantNormalized.trim()) {
      const newAmount = new Prisma.Decimal(t.amount);
      const occurredAt = plaidOccurredAt(t);
      const postedAt = plaidPostedAt(t);
      const candidates = await tx.transaction.findMany({
        where: {
          workspaceId,
          accountId: oldAccountId,
          source: "plaid",
          plaidTransactionId: { not: null },
          plaidItem: { is: { status: "disconnected" } },
          occurredAt,
          amount: newAmount,
        },
        select: { id: true, merchantRaw: true, merchantNormalized: true },
      });
      const strongMatches = candidates.filter((candidate) => {
        const existingMerchant = candidateReconnectMerchantNormalized(candidate);
        return existingMerchant === merchantNormalized;
      });
      if (strongMatches.length === 1) {
        await tx.transaction.update({
          where: { id: strongMatches[0]!.id },
          data: {
            accountId,
            plaidItemId,
            plaidTransactionId: t.transaction_id,
            plaidPendingTransactionId: t.pending_transaction_id ?? null,
            amount: newAmount,
            occurredAt,
            postedAt,
            pending: t.pending,
            merchantRaw: plaidMerchantRaw(t),
            merchantNormalized,
            rawData: t as unknown as Prisma.InputJsonValue,
            removedAt: null,
          },
        });
        return { kind: "updated", localId: strongMatches[0]!.id };
      }
    }
  }
  const created = await tx.transaction.create({
    data: {
      workspaceId,
      accountId,
      plaidItemId,
      plaidTransactionId: t.transaction_id,
      plaidPendingTransactionId: t.pending_transaction_id ?? null,
      amount: t.amount,
      merchantRaw: plaidMerchantRaw(t),
      occurredAt: plaidOccurredAt(t),
      postedAt: plaidPostedAt(t),
      pending: t.pending,
      rawData: t as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, amount: true },
  });
  await tx.transactionAllocation.create({
    data: {
      transactionId: created.id,
      categoryId: null,
      amount: created.amount,
      source: null,
    },
  });
  return { kind: "inserted", localId: created.id };
}

export async function upsertModified(
  tx: Prisma.TransactionClient,
  t: PlaidTxLike,
  workspaceId: string,
): Promise<void> {
  // Note: no removedAt filter — matches today's updateMany scope; soft-removed
  // rows still get field updates for state consistency.
  const existing = await tx.transaction.findFirst({
    where: { workspaceId, plaidTransactionId: t.transaction_id },
    include: { allocations: { select: { id: true, amount: true } } },
  });
  if (!existing) return; // matches today's no-op for missing row

  const oldAmount = existing.amount;
  const newAmount = new Prisma.Decimal(t.amount);
  const amountChanged = !oldAmount.equals(newAmount);
  const newMerchantRaw = plaidMerchantRaw(t);
  const merchantChanged = existing.merchantRaw !== newMerchantRaw;
  const N = existing.allocations.length;

  const txDataBase = {
    amount: newAmount,
    merchantRaw: newMerchantRaw,
    occurredAt: plaidOccurredAt(t),
    postedAt: plaidPostedAt(t),
    pending: t.pending,
    rawData: t as unknown as Prisma.InputJsonValue,
  };

  if (N >= 2 && (amountChanged || merchantChanged)) {
    // Invalidate split: replace allocations with 1 null-cat row + set flag.
    await tx.transactionAllocation.deleteMany({ where: { transactionId: existing.id } });
    await tx.transactionAllocation.create({
      data: {
        transactionId: existing.id,
        categoryId: null,
        amount: newAmount,
        source: null,
      },
    });
    await tx.transaction.update({
      where: { id: existing.id },
      data: { ...txDataBase, needsReclassification: true },
    });
  } else {
    // N=1 (any change) OR N≥2 with only metadata changes: preserve allocations.
    if (amountChanged && N === 1) {
      await tx.transactionAllocation.update({
        where: { id: existing.allocations[0]!.id },
        data: { amount: newAmount },
      });
    }
    await tx.transaction.update({
      where: { id: existing.id },
      data: txDataBase,
    });
  }
}

export async function markRemoved(
  tx: Prisma.TransactionClient,
  plaidTransactionId: string,
  workspaceId: string,
): Promise<void> {
  // First select the local tx to get its id (so we can clear schedule matches).
  const target = await tx.transaction.findFirst({
    where: { workspaceId, plaidTransactionId, removedAt: null },
    select: { id: true },
  });
  if (!target) return; // nothing to remove
  await clearScheduleMatch(tx, target.id);
  await tx.transaction.update({
    where: { id: target.id },
    data: { removedAt: new Date() },
  });
}
