import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import { normalizeMerchant } from "../categorize/normalize.js";
import {
  TxValidationError,
  validateAmount,
  validateMerchantRaw,
  validateNote,
  parseOccurredAt,
} from "./validators.js";

export type EditTxInput = {
  amount?: number;
  merchantRaw?: string;
  occurredAt?: string;
  categoryId?: string | null;
  note?: string | null;
};

export type EditTxResult = {
  transaction: {
    id: string;
    accountId: string;
    plaidTransactionId: null;
    amount: string;
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: string | null;
    occurredAt: string;
    pending: false;
    source: "manual";
    note: string | null;
    removedAt: null;
    createdAt: string;
    updatedAt: string;
  };
};

export type EditTxErrorCode =
  | "not_found"
  | "not_editable"
  | "already_removed"
  | "category_not_found"
  | "invalid_amount"
  | "invalid_date"
  | "invalid_merchant"
  | "invalid_note";

export class EditTxError extends Error {
  readonly code: EditTxErrorCode;
  constructor(code: EditTxErrorCode) {
    super(code);
    this.name = "EditTxError";
    this.code = code;
  }
}

function rethrowValidation<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof TxValidationError) throw new EditTxError(e.code);
    throw e;
  }
}

const TX_SELECT = {
  id: true, accountId: true, plaidTransactionId: true,
  amount: true, merchantRaw: true, merchantNormalized: true,
  categoryId: true, occurredAt: true, pending: true,
  source: true, note: true, removedAt: true,
  createdAt: true, updatedAt: true,
} as const;

function shape(
  row: Prisma.TransactionGetPayload<{ select: typeof TX_SELECT }>,
  currency: string,
): EditTxResult["transaction"] {
  return {
    id: row.id,
    accountId: row.accountId,
    plaidTransactionId: null,
    amount: row.amount.toString(),
    currency,
    merchantRaw: row.merchantRaw,
    merchantNormalized: row.merchantNormalized ?? normalizeMerchant(row.merchantRaw),
    categoryId: row.categoryId,
    occurredAt: row.occurredAt.toISOString(),
    pending: false,
    source: "manual",
    note: row.note,
    removedAt: null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function editTransactionService(
  ctx: { workspaceId: string },
  txId: string,
  input: EditTxInput,
): Promise<EditTxResult> {
  // Validate input fields up-front (purely input-shape checks). Mapping
  // TxValidationError → EditTxError preserves the 1:1 code names.
  if (input.amount !== undefined) rethrowValidation(() => validateAmount(input.amount as number));
  let trimmedMerchant: string | undefined;
  if (input.merchantRaw !== undefined) trimmedMerchant = rethrowValidation(() => validateMerchantRaw(input.merchantRaw as string));
  let parsedOccurredAt: Date | undefined;
  if (input.occurredAt !== undefined) parsedOccurredAt = rethrowValidation(() => parseOccurredAt(input.occurredAt as string));
  let normalizedNote: string | null = null;
  let noteProvided = false;
  if (input.note !== undefined) {
    noteProvided = true;
    normalizedNote = rethrowValidation(() => validateNote(input.note));
  }

  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: ctx.workspaceId },
    select: { currency: true },
  });

  return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const row = await tx.transaction.findFirst({
      where: { id: txId, workspaceId: ctx.workspaceId },
      select: TX_SELECT,
    });
    if (!row) throw new EditTxError("not_found");
    if (row.source !== "manual") throw new EditTxError("not_editable");
    if (row.removedAt !== null) throw new EditTxError("already_removed");

    if (input.categoryId !== undefined && input.categoryId !== null) {
      const cat = await tx.category.findFirst({
        where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!cat) throw new EditTxError("category_not_found");
    }

    // Use TransactionUncheckedUpdateInput (NOT TransactionUpdateInput):
    // the latter exposes the `category` relation but not the scalar `categoryId`
    // FK column, so `data.categoryId = ...` would fail typecheck.
    const data: Prisma.TransactionUncheckedUpdateInput = {};
    if (input.amount !== undefined) data.amount = new Prisma.Decimal(input.amount);
    if (trimmedMerchant !== undefined) {
      data.merchantRaw = trimmedMerchant;
      data.merchantNormalized = normalizeMerchant(trimmedMerchant);
    }
    if (parsedOccurredAt !== undefined) data.occurredAt = parsedOccurredAt;
    if (input.categoryId !== undefined) {
      data.categoryId = input.categoryId;
      data.categorizationSource = input.categoryId === null ? null : "manual";
    }
    if (noteProvided) data.note = normalizedNote;

    if (Object.keys(data).length === 0) {
      return { transaction: shape(row, workspace.currency) };
    }

    const updated = await tx.transaction.update({
      where: { id: txId },
      data,
      select: TX_SELECT,
    });
    return { transaction: shape(updated, workspace.currency) };
  });
}
