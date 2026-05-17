import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { normalizeMerchant } from "../categorize/normalize.js";

export type Cadence = "monthly" | "semimonthly" | "biweekly" | "weekly" | "yearly";

const MAX_AMOUNT = 99_999_999.99;

export type AddRecurringInput = {
  name: string;
  amount: number;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId?: string | null;
  merchant?: string | null;
  currency?: string;
};

export type RecurringRow = {
  id: string;
  name: string;
  amount: string;
  currency: string;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId: string | null;
  merchantNormalized: string | null;
};

export type AddRecurringOutput = { recurring: RecurringRow };
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

function formatRow(row: {
  id: string;
  name: string;
  amount: Prisma.Decimal;
  currency: string;
  cadence: Cadence;
  nextOccurrenceDate: Date;
  categoryId: string | null;
  merchantNormalized: string | null;
}): RecurringRow {
  return {
    id: row.id,
    name: row.name,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    cadence: row.cadence,
    nextOccurrenceDate: row.nextOccurrenceDate.toISOString().slice(0, 10),
    categoryId: row.categoryId,
    merchantNormalized: row.merchantNormalized,
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
  const data = {
    workspaceId: ctx.workspaceId,
    name: input.name,
    nameNormalized,
    amount: new Prisma.Decimal(input.amount),
    currency: (input.currency ?? "CAD").toUpperCase(),
    categoryId: input.categoryId ?? null,
    merchantNormalized,
    cadence: input.cadence,
    nextOccurrenceDate: periodDate,
  };
  const row = await prisma.recurringExpense.upsert({
    where: {
      workspaceId_nameNormalized: {
        workspaceId: ctx.workspaceId,
        nameNormalized,
      },
    },
    create: data,
    update: {
      name: data.name,
      amount: data.amount,
      currency: data.currency,
      categoryId: data.categoryId,
      merchantNormalized: data.merchantNormalized,
      cadence: data.cadence,
      nextOccurrenceDate: data.nextOccurrenceDate,
    },
  });
  return { recurring: formatRow(row) };
}

export async function listRecurringService(
  ctx: { workspaceId: string },
): Promise<ListRecurringOutput> {
  const rows = await prisma.recurringExpense.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: [{ nextOccurrenceDate: "asc" }, { name: "asc" }],
  });
  return { recurring: rows.map(formatRow) };
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
