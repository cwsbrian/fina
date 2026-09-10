import type {
  CategorizationSource,
  Prisma,
  PrismaClient,
} from "@prisma/client";

import { normalizeMerchant } from "../categorize/normalize.js";
import { prisma } from "../db.js";
import { withWorkspaceLock } from "../locks/workspace.js";

const DAY_MS = 86_400_000;

type AccountRow = {
  id: string;
  workspaceId: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string;
  plaidItemId: string | null;
  plaidInstitutionId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  plaidItem: { institutionId: string; status: string } | null;
};

type TransactionRow = {
  id: string;
  workspaceId: string;
  accountId: string;
  plaidItemId: string | null;
  plaidTransactionId: string | null;
  amount: Prisma.Decimal;
  merchantRaw: string;
  merchantNormalized: string | null;
  occurredAt: Date;
  postedAt: Date | null;
  createdAt: Date;
};

export type ReconnectDuplicateCandidate = {
  workspaceId: string;
  historicalTransactionId: string;
  currentTransactionId: string;
  historicalPlaidTransactionId: string;
  currentPlaidTransactionId: string;
  historicalAccountId: string;
  currentAccountId: string;
  historicalAccountName: string;
  currentAccountName: string;
  amount: string;
  merchant: string;
  historicalOccurredAt: Date;
  currentOccurredAt: Date;
  matchBasis: "occurred_date" | "posted_date";
  dateDeltaDays: number;
  subtypeChanged: boolean;
};

export type ReconnectDedupeResult = {
  email: string;
  candidates: ReconnectDuplicateCandidate[];
  hardDeletedCurrent: number;
  skipped: number;
};

function institutionId(account: AccountRow): string | null {
  return account.plaidInstitutionId ?? account.plaidItem?.institutionId ?? null;
}

function normalizedAccountName(value: string): string {
  return value.trim().toLocaleLowerCase("en-CA").replace(/\s+/g, " ");
}

function sameReconnectedAccount(historical: AccountRow, current: AccountRow): boolean {
  const historicalInstitution = institutionId(historical);
  const currentInstitution = institutionId(current);
  const institutionMatches =
    historicalInstitution !== null && historicalInstitution === currentInstitution;
  // Some accounts were archived before plaidInstitutionId was backfilled. In
  // that legacy case, use the remaining exact Plaid account fingerprint. Keep
  // subtype in this fallback because the institution safety signal is absent.
  const legacyFingerprintMatches =
    historicalInstitution === null &&
    currentInstitution !== null &&
    normalizedAccountName(historical.name) === normalizedAccountName(current.name) &&
    historical.subtype === current.subtype;
  return (
    historical.archivedAt !== null &&
    current.archivedAt === null &&
    current.plaidItemId !== null &&
    current.plaidItem?.status !== "disconnected" &&
    (institutionMatches || legacyFingerprintMatches) &&
    historical.mask !== null &&
    historical.mask === current.mask &&
    historical.type === current.type &&
    historical.currency === current.currency &&
    current.createdAt >= historical.archivedAt
  );
}

function merchantKey(row: Pick<TransactionRow, "merchantRaw" | "merchantNormalized">): string {
  const raw = row.merchantRaw.trim();
  if (!raw || raw.toLowerCase() === "unknown") return "";
  return row.merchantNormalized?.trim() || normalizeMerchant(raw);
}

function utcDayNumber(value: Date): number {
  return Math.floor(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / DAY_MS,
  );
}

function transactionDateMatch(
  historical: TransactionRow,
  current: TransactionRow,
  dateWindowDays: number,
): Pick<ReconnectDuplicateCandidate, "matchBasis" | "dateDeltaDays"> | null {
  const options: Array<Pick<ReconnectDuplicateCandidate, "matchBasis" | "dateDeltaDays">> = [
    {
      matchBasis: "occurred_date",
      dateDeltaDays: Math.abs(
        utcDayNumber(historical.occurredAt) - utcDayNumber(current.occurredAt),
      ),
    },
  ];
  if (historical.postedAt && current.postedAt) {
    options.push({
      matchBasis: "posted_date",
      dateDeltaDays: Math.abs(
        utcDayNumber(historical.postedAt) - utcDayNumber(current.postedAt),
      ),
    });
  }
  const best = options.sort((a, b) => a.dateDeltaDays - b.dateDeltaDays)[0]!;
  return best.dateDeltaDays <= dateWindowDays ? best : null;
}

function duplicateMatch(
  historical: TransactionRow,
  current: TransactionRow,
  dateWindowDays: number,
): Pick<ReconnectDuplicateCandidate, "matchBasis" | "dateDeltaDays"> | null {
  if (
    historical.id === current.id ||
    historical.plaidTransactionId === null ||
    current.plaidTransactionId === null ||
    historical.plaidTransactionId === current.plaidTransactionId ||
    historical.amount.comparedTo(current.amount) !== 0 ||
    historical.createdAt > current.createdAt
  ) {
    return null;
  }
  const historicalMerchant = merchantKey(historical);
  if (!historicalMerchant || historicalMerchant !== merchantKey(current)) return null;
  return transactionDateMatch(historical, current, dateWindowDays);
}

export async function findReconnectDuplicateCandidatesByEmail(
  email: string,
  options: { dateWindowDays?: number } = {},
  client: PrismaClient = prisma,
): Promise<{ email: string; candidates: ReconnectDuplicateCandidate[] }> {
  const normalizedEmail = email.trim().toLowerCase();
  const dateWindowDays = options.dateWindowDays ?? 0;
  if (!normalizedEmail.includes("@")) throw new Error("A valid --email is required");
  if (!Number.isInteger(dateWindowDays) || dateWindowDays < 0 || dateWindowDays > 3) {
    throw new Error("--date-window-days must be an integer from 0 to 3");
  }

  const user = await client.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      email: true,
      memberships: { select: { workspaceId: true } },
    },
  });
  if (!user) throw new Error(`User not found: ${normalizedEmail}`);
  const workspaceIds = [...new Set(user.memberships.map((membership) => membership.workspaceId))];
  if (workspaceIds.length === 0) return { email: user.email, candidates: [] };

  const accounts = await client.bankAccount.findMany({
    where: {
      workspaceId: { in: workspaceIds },
      plaidAccountId: { not: null },
    },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      mask: true,
      type: true,
      subtype: true,
      currency: true,
      plaidItemId: true,
      plaidInstitutionId: true,
      archivedAt: true,
      createdAt: true,
      plaidItem: { select: { institutionId: true, status: true } },
    },
    orderBy: [{ workspaceId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const historicalAccounts = accounts.filter((account) => account.archivedAt !== null);
  const currentAccounts = accounts.filter((account) => account.archivedAt === null);
  const accountIds = accounts.map((account) => account.id);
  if (accountIds.length === 0) return { email: user.email, candidates: [] };

  const transactions = await client.transaction.findMany({
    where: {
      workspaceId: { in: workspaceIds },
      accountId: { in: accountIds },
      source: "plaid",
      plaidTransactionId: { not: null },
      removedAt: null,
    },
    select: {
      id: true,
      workspaceId: true,
      accountId: true,
      plaidItemId: true,
      plaidTransactionId: true,
      amount: true,
      merchantRaw: true,
      merchantNormalized: true,
      occurredAt: true,
      postedAt: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const transactionsByAccount = new Map<string, TransactionRow[]>();
  for (const transaction of transactions) {
    const rows = transactionsByAccount.get(transaction.accountId) ?? [];
    rows.push(transaction);
    transactionsByAccount.set(transaction.accountId, rows);
  }

  type Edge = {
    historicalAccount: AccountRow;
    currentAccount: AccountRow;
    historical: TransactionRow;
    current: TransactionRow;
    date: NonNullable<ReturnType<typeof duplicateMatch>>;
  };
  const edges: Edge[] = [];
  for (const currentAccount of currentAccounts) {
    for (const historicalAccount of historicalAccounts) {
      if (
        historicalAccount.workspaceId !== currentAccount.workspaceId ||
        !sameReconnectedAccount(historicalAccount, currentAccount)
      ) {
        continue;
      }
      for (const current of transactionsByAccount.get(currentAccount.id) ?? []) {
        if (current.createdAt < historicalAccount.archivedAt!) continue;
        for (const historical of transactionsByAccount.get(historicalAccount.id) ?? []) {
          const date = duplicateMatch(historical, current, dateWindowDays);
          if (date) {
            edges.push({ historicalAccount, currentAccount, historical, current, date });
          }
        }
      }
    }
  }

  edges.sort((a, b) =>
    a.date.dateDeltaDays - b.date.dateDeltaDays ||
    a.current.createdAt.getTime() - b.current.createdAt.getTime() ||
    a.historical.createdAt.getTime() - b.historical.createdAt.getTime() ||
    a.current.id.localeCompare(b.current.id) ||
    a.historical.id.localeCompare(b.historical.id),
  );
  const usedHistorical = new Set<string>();
  const usedCurrent = new Set<string>();
  const candidates: ReconnectDuplicateCandidate[] = [];
  for (const edge of edges) {
    if (usedHistorical.has(edge.historical.id) || usedCurrent.has(edge.current.id)) continue;
    usedHistorical.add(edge.historical.id);
    usedCurrent.add(edge.current.id);
    candidates.push({
      workspaceId: edge.current.workspaceId,
      historicalTransactionId: edge.historical.id,
      currentTransactionId: edge.current.id,
      historicalPlaidTransactionId: edge.historical.plaidTransactionId!,
      currentPlaidTransactionId: edge.current.plaidTransactionId!,
      historicalAccountId: edge.historicalAccount.id,
      currentAccountId: edge.currentAccount.id,
      historicalAccountName: edge.historicalAccount.name,
      currentAccountName: edge.currentAccount.name,
      amount: edge.current.amount.toString(),
      merchant: edge.current.merchantNormalized?.trim() || edge.current.merchantRaw,
      historicalOccurredAt: edge.historical.occurredAt,
      currentOccurredAt: edge.current.occurredAt,
      matchBasis: edge.date.matchBasis,
      dateDeltaDays: edge.date.dateDeltaDays,
      subtypeChanged: edge.historicalAccount.subtype !== edge.currentAccount.subtype,
    });
  }
  return { email: user.email, candidates };
}

function allocationRank(
  allocations: Array<{ source: CategorizationSource | null; businessAmount?: Prisma.Decimal | null; receiptLineItemId?: string | null }>,
): number {
  const sourceRank: Record<CategorizationSource, number> = {
    manual: 4,
    mapping: 3,
    history: 2,
    ai: 1,
  };
  const rank = allocations.reduce(
    (best, allocation) => Math.max(best, allocation.source ? sourceRank[allocation.source] : 0),
    0,
  );
  const evidenceRank = allocations.some((allocation) => allocation.receiptLineItemId) ? 100
    : allocations.some((allocation) => allocation.businessAmount !== null && allocation.businessAmount !== undefined) ? 50 : 0;
  return evidenceRank + (allocations.length > 1 ? rank + 10 : rank);
}

async function hardDeleteCurrentCandidate(
  candidate: ReconnectDuplicateCandidate,
  dateWindowDays: number,
): Promise<boolean> {
  return await withWorkspaceLock(candidate.workspaceId, async (tx) => {
    const [historical, current] = await Promise.all([
      tx.transaction.findUnique({
        where: { id: candidate.historicalTransactionId },
        include: { account: { include: { plaidItem: true } }, allocations: true },
      }),
      tx.transaction.findUnique({
        where: { id: candidate.currentTransactionId },
        include: { account: { include: { plaidItem: true } }, allocations: true },
      }),
    ]);
    if (
      !historical ||
      !current ||
      historical.workspaceId !== candidate.workspaceId ||
      current.workspaceId !== candidate.workspaceId ||
      historical.removedAt !== null ||
      current.removedAt !== null ||
      !sameReconnectedAccount(historical.account, current.account) ||
      !duplicateMatch(historical, current, dateWindowDays)
    ) {
      return false;
    }

    const preferCurrentAllocations = allocationRank(current.allocations) > allocationRank(historical.allocations);
    if (preferCurrentAllocations) {
      await tx.transactionAllocation.deleteMany({ where: { transactionId: historical.id } });
      await tx.transactionAllocation.updateMany({
        where: { id: { in: current.allocations.map((allocation) => allocation.id) } },
        data: { receiptLineItemId: null },
      });
      await tx.transactionAllocation.createMany({
        data: current.allocations.map((allocation) => ({
          transactionId: historical.id,
          categoryId: allocation.categoryId,
          amount: allocation.amount,
          source: allocation.source,
          needsConfirmation: allocation.needsConfirmation,
          dismissedUntil: allocation.dismissedUntil,
          businessAmount: allocation.businessAmount,
          receiptLineItemId: allocation.receiptLineItemId,
        })),
      });
    }

    await tx.scheduledSpend.updateMany({
      where: { matchedTxId: current.id },
      data: { matchedTxId: historical.id },
    });
    await tx.transaction.updateMany({
      where: { refundOfTransactionId: current.id, id: { not: historical.id } },
      data: { refundOfTransactionId: historical.id },
    });
    await tx.receiptDocument.updateMany({
      where: { transactionId: current.id },
      data: { transactionId: historical.id },
    });
    const refundOfTransactionId =
      historical.refundOfTransactionId &&
      historical.refundOfTransactionId !== current.id &&
      historical.refundOfTransactionId !== historical.id
        ? historical.refundOfTransactionId
        : current.refundOfTransactionId &&
            current.refundOfTransactionId !== current.id &&
            current.refundOfTransactionId !== historical.id
          ? current.refundOfTransactionId
          : null;
    const keepCurrentBudgetImpact =
      historical.budgetImpactSource !== "user" && current.budgetImpactSource === "user";

    // The newly imported row owns the current Plaid transaction ID. Delete it
    // first to release the workspace-scoped unique key, then attach that Plaid
    // identity to the preserved historical row.
    await tx.transaction.delete({ where: { id: current.id } });
    await tx.transaction.update({
      where: { id: historical.id },
      data: {
        version: { increment: 1 },
        accountId: current.accountId,
        plaidItemId: current.plaidItemId,
        plaidTransactionId: current.plaidTransactionId,
        plaidPendingTransactionId: current.plaidPendingTransactionId,
        amount: current.amount,
        merchantRaw: current.merchantRaw,
        merchantNormalized: current.merchantNormalized,
        occurredAt: current.occurredAt,
        postedAt: current.postedAt,
        pending: current.pending,
        rawData: current.rawData as Prisma.InputJsonValue,
        removedAt: null,
        note: historical.note ?? current.note,
        businessPurpose: historical.businessPurpose ?? current.businessPurpose,
        receiptMissingReason: historical.receiptMissingReason ?? current.receiptMissingReason,
        receiptMissingNote: historical.receiptMissingNote ?? current.receiptMissingNote,
        classificationSourceReceiptId: preferCurrentAllocations
          ? current.classificationSourceReceiptId ?? historical.classificationSourceReceiptId
          : historical.classificationSourceReceiptId ?? current.classificationSourceReceiptId,
        ...(keepCurrentBudgetImpact
          ? {
              budgetImpact: current.budgetImpact,
              budgetImpactSource: current.budgetImpactSource,
            }
          : {}),
        refundOfTransactionId,
        needsReclassification:
          current.needsReclassification || historical.needsReclassification,
      },
    });
    return true;
  });
}

export async function dedupeReconnectTransactionsByEmail(
  email: string,
  options: { apply?: boolean; dateWindowDays?: number } = {},
): Promise<ReconnectDedupeResult> {
  const dateWindowDays = options.dateWindowDays ?? 0;
  const found = await findReconnectDuplicateCandidatesByEmail(email, { dateWindowDays });
  if (!options.apply) {
    return { ...found, hardDeletedCurrent: 0, skipped: 0 };
  }

  let hardDeletedCurrent = 0;
  let skipped = 0;
  for (const candidate of found.candidates) {
    if (await hardDeleteCurrentCandidate(candidate, dateWindowDays)) hardDeletedCurrent++;
    else skipped++;
  }
  return { ...found, hardDeletedCurrent, skipped };
}
