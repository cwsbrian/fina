import { Prisma } from "@prisma/client";
import { MAX_AMOUNT, type Cadence } from "@fina/shared";
import { prisma } from "../db.js";
import { normalizeMerchant } from "../categorize/normalize.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import { occurrencesInRange, monthlyEquivalent } from "./occurrences.js";

export type { Cadence };

export type AddRecurringInput = {
  name: string;
  amount: number;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId?: string | null;
  merchant?: string | null;
};

export type RecurringRow = {
  id: string;
  name: string;
  amount: string;
  currency: string;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId: string | null;
  categoryName: string | null;
  merchantNormalized: string | null;
  /** Amount amortized to a monthly figure — for the Subscriptions
   *  hero math. Stringified to two decimals like `amount`. */
  monthlyEquivalent: string;
  /** YYYY-MM-DD dates of this subscription's occurrences from today
   *  through the end of the current month. Used by the Scheduled
   *  screen + budget projection. */
  remainingThisMonth: string[];
  createdAt: string;
};

export type AddRecurringOutput = {
  recurring: RecurringRow;
  /** True when the upsert inserted a new row; false when it updated an
   *  existing row matched by case-insensitive name. Lets the chat
   *  confirmation copy say "Added" vs "Updated". */
  wasCreated: boolean;
};
export type ListRecurringOutput = { recurring: RecurringRow[] };

function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

// Strict YYYY-MM-DD validation: shape + round-trip. Uses .exec captures so
// noUncheckedIndexedAccess doesn't leave number|undefined values flowing
// into Date.UTC and arithmetic.
function isValidDateOnly(s: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return false;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return false;
  if (m < 1 || m > 12) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(date.getTime())) return false;
  const back =
    `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  return back === s;
}

type FormattableRow = {
  id: string;
  name: string;
  amount: Prisma.Decimal;
  cadence: Cadence;
  nextOccurrenceDate: Date;
  categoryId: string | null;
  category?: { name: string } | null;
  merchantNormalized: string | null;
  createdAt: Date;
};

function todayUTCMidnight(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function endOfThisMonthUTC(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
}

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatRow(
  row: FormattableRow,
  workspaceCurrency: string,
): RecurringRow {
  const amountNum = Number(row.amount);
  const monthlyEq = monthlyEquivalent(amountNum, row.cadence);
  const remaining = occurrencesInRange(
    row.nextOccurrenceDate,
    row.cadence,
    todayUTCMidnight(),
    endOfThisMonthUTC(),
  );
  return {
    id: row.id,
    name: row.name,
    amount: row.amount.toFixed(2),
    currency: workspaceCurrency,
    cadence: row.cadence,
    nextOccurrenceDate: toYMD(row.nextOccurrenceDate),
    categoryId: row.categoryId,
    categoryName: row.category?.name ?? null,
    merchantNormalized: row.merchantNormalized,
    monthlyEquivalent: monthlyEq.toFixed(2),
    remainingThisMonth: remaining.map(toYMD),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function addRecurringService(
  ctx: { workspaceId: string },
  input: AddRecurringInput,
): Promise<AddRecurringOutput> {
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_AMOUNT) {
    throw new Error("invalid_amount");
  }
  if (!isValidDateOnly(input.nextOccurrenceDate)) {
    throw new Error("invalid_next_date");
  }
  const nameNormalized = normalizeName(input.name);
  if (nameNormalized.length === 0) throw new Error("invalid_body");

  let merchantNormalized: string | null = null;
  if (input.merchant != null && input.merchant !== "") {
    const m = normalizeMerchant(input.merchant);
    if (m.length === 0) throw new Error("invalid_merchant");
    merchantNormalized = m;
  }

  if (input.categoryId) {
    const cat = await prisma.category.findFirst({
      where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!cat) throw new Error("category_not_found");
  }

  const periodDate = new Date(`${input.nextOccurrenceDate}T12:00:00.000Z`);
  const createData = {
    workspaceId: ctx.workspaceId,
    name: input.name,
    nameNormalized,
    amount: new Prisma.Decimal(input.amount),
    categoryId: input.categoryId ?? null,
    merchantNormalized,
    cadence: input.cadence,
    nextOccurrenceDate: periodDate,
  };
  const { row, wasCreated } = await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const existing = await tx.recurringExpense.findUnique({
      where: {
        workspaceId_nameNormalized: { workspaceId: ctx.workspaceId, nameNormalized },
      },
      select: { id: true },
    });
    const upserted = await tx.recurringExpense.upsert({
      where: {
        workspaceId_nameNormalized: {
          workspaceId: ctx.workspaceId,
          nameNormalized,
        },
      },
      create: createData,
      update: {
        name: createData.name,
        amount: createData.amount,
        categoryId: createData.categoryId,
        merchantNormalized: createData.merchantNormalized,
        cadence: createData.cadence,
        nextOccurrenceDate: createData.nextOccurrenceDate,
      },
      include: { category: { select: { name: true } } },
    });
    return { row: upserted, wasCreated: !existing };
  });
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: ctx.workspaceId },
    select: { currency: true },
  });
  return { recurring: formatRow(row, workspace.currency), wasCreated };
}

export async function listRecurringService(
  ctx: { workspaceId: string },
): Promise<ListRecurringOutput> {
  const [rows, workspace] = await Promise.all([
    prisma.recurringExpense.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: [{ nextOccurrenceDate: "asc" }, { name: "asc" }],
      include: { category: { select: { name: true } } },
    }),
    prisma.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { currency: true },
    }),
  ]);
  return { recurring: rows.map((r) => formatRow(r, workspace.currency)) };
}

export type UpdateRecurringInput = AddRecurringInput & { id: string };

export async function updateRecurringService(
  ctx: { workspaceId: string },
  input: UpdateRecurringInput,
): Promise<AddRecurringOutput> {
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_AMOUNT) {
    throw new Error("invalid_amount");
  }
  if (!isValidDateOnly(input.nextOccurrenceDate)) {
    throw new Error("invalid_next_date");
  }
  const nameNormalized = normalizeName(input.name);
  if (nameNormalized.length === 0) throw new Error("invalid_body");

  let merchantNormalized: string | null = null;
  if (input.merchant != null && input.merchant !== "") {
    const m = normalizeMerchant(input.merchant);
    if (m.length === 0) throw new Error("invalid_merchant");
    merchantNormalized = m;
  }

  if (input.categoryId) {
    const cat = await prisma.category.findFirst({
      where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!cat) throw new Error("category_not_found");
  }

  const periodDate = new Date(`${input.nextOccurrenceDate}T12:00:00.000Z`);
  const row = await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const existing = await tx.recurringExpense.findFirst({
      where: { id: input.id, workspaceId: ctx.workspaceId },
      select: { id: true, nameNormalized: true },
    });
    if (!existing) throw new Error("not_found");
    // Rename collision: if the new normalized name is taken by a
    // different row, reject — the unique index would 500 the request.
    if (nameNormalized !== existing.nameNormalized) {
      const conflict = await tx.recurringExpense.findUnique({
        where: {
          workspaceId_nameNormalized: {
            workspaceId: ctx.workspaceId,
            nameNormalized,
          },
        },
        select: { id: true },
      });
      if (conflict && conflict.id !== input.id) {
        throw new Error("name_conflict");
      }
    }
    return await tx.recurringExpense.update({
      where: { id: input.id },
      data: {
        name: input.name,
        nameNormalized,
        amount: new Prisma.Decimal(input.amount),
        categoryId: input.categoryId ?? null,
        merchantNormalized,
        cadence: input.cadence,
        nextOccurrenceDate: periodDate,
      },
      include: { category: { select: { name: true } } },
    });
  });
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: ctx.workspaceId },
    select: { currency: true },
  });
  return { recurring: formatRow(row, workspace.currency), wasCreated: false };
}

export async function removeRecurringByIdService(
  ctx: { workspaceId: string },
  input: { id: string },
): Promise<boolean> {
  const { count } = await prisma.recurringExpense.deleteMany({
    where: { id: input.id, workspaceId: ctx.workspaceId },
  });
  return count > 0;
}

export async function removeRecurringByNameService(
  ctx: { workspaceId: string },
  input: { name: string },
): Promise<boolean> {
  const nameNormalized = normalizeName(input.name);
  if (nameNormalized.length === 0) return false;
  const row = await prisma.recurringExpense.findUnique({
    where: {
      workspaceId_nameNormalized: {
        workspaceId: ctx.workspaceId,
        nameNormalized,
      },
    },
    select: { id: true },
  });
  if (!row) return false;
  return removeRecurringByIdService(ctx, { id: row.id });
}
