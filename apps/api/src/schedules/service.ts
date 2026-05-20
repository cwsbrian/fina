import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { withWorkspaceLock } from "../locks/workspace.js";
import {
  TxValidationError,
  validateAmount,
  validateNote,
  parseOccurredAt,  // YYYY-MM-DD validator
} from "../transactions/validators.js";

export type ScheduledSpendStatus =
  | "upcoming"
  | "unresolved"
  | "resolved-matched"
  | "resolved-dismissed";

export type ScheduledSpendErrorCode =
  | "invalid_amount"
  | "invalid_date"
  | "invalid_note"
  | "category_not_found"
  | "not_found"
  | "already_matched";

export class ScheduledSpendError extends Error {
  readonly code: ScheduledSpendErrorCode;
  constructor(code: ScheduledSpendErrorCode) {
    super(code);
    this.name = "ScheduledSpendError";
    this.code = code;
  }
}

function rethrowValidation<T>(fn: () => T): T {
  try { return fn(); }
  catch (e) {
    if (e instanceof TxValidationError) throw new ScheduledSpendError(e.code as ScheduledSpendErrorCode);
    throw e;
  }
}

export type AddScheduledSpendInput = {
  workspaceId: string;
  categoryId: string;
  amount: number;
  scheduledDate: string;  // YYYY-MM-DD
  note?: string;
};

type ScheduleDTO = {
  id: string;
  categoryId: string;
  amount: string;
  scheduledDate: string;  // YYYY-MM-DD
  note: string | null;
  matchedTxId: string | null;
  dismissedAt: string | null;
  status: ScheduledSpendStatus;
};

export type AddScheduledSpendResult = {
  schedule: ScheduleDTO;
};

type ScheduleRow = Prisma.ScheduledSpendGetPayload<{
  include: { matchedTx: { select: { removedAt: true } } };
}>;

// Note: `parseOccurredAt` (from validators.ts) returns a Date at noon UTC
// (`+T12:00:00Z`). Postgres `@db.Date` truncates to the date component on
// storage; reads return midnight UTC. So we never see the noon-UTC instant
// after a round trip — but if reading `scheduledDate` straight from input
// before storage, treat the noon-UTC quirk as benign (date components match
// the user's intent in every supported tz).

function deriveStatus(row: ScheduleRow, todayDateOnly: Date): ScheduledSpendStatus {
  // matched and tx still active → resolved-matched
  if (row.matchedTxId && row.matchedTx && row.matchedTx.removedAt === null) {
    return "resolved-matched";
  }
  // dismissed (and not resolved-matched) → resolved-dismissed
  if (row.dismissedAt !== null) {
    return "resolved-dismissed";
  }
  // todayDateOnly is computed by the caller as the wall-clock date in
  // the calling user's tz, already normalized to midnight-UTC of that date
  // (so Date.UTC component comparisons line up with scheduledDate's @db.Date
  // round-trip representation).
  const schedDayMs = Date.UTC(
    row.scheduledDate.getUTCFullYear(),
    row.scheduledDate.getUTCMonth(),
    row.scheduledDate.getUTCDate(),
  );
  const todayDayMs = todayDateOnly.getTime();
  return schedDayMs >= todayDayMs ? "upcoming" : "unresolved";
}

function toDTO(row: ScheduleRow, todayDateOnly: Date): ScheduleDTO {
  return {
    id: row.id,
    categoryId: row.categoryId,
    amount: row.amount.toString(),
    scheduledDate: row.scheduledDate.toISOString().slice(0, 10),
    note: row.note,
    matchedTxId: row.matchedTxId,
    dismissedAt: row.dismissedAt?.toISOString() ?? null,
    status: deriveStatus(row, todayDateOnly),
  };
}

/**
 * Compute the calling user's wall-clock "today" as a UTC midnight Date,
 * so component-by-component comparisons against scheduledDate (Postgres
 * `@db.Date` round-trip → midnight UTC) line up.
 */
async function todayDateOnlyForUser(userId: string): Promise<Date> {
  const { resolveUserTz, partsInTz } = await import("../chat/tools/periods.js");
  const tz = await resolveUserTz(userId);
  const parts = partsInTz(new Date(), tz);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
}

export async function addScheduledSpendService(
  input: AddScheduledSpendInput,
): Promise<AddScheduledSpendResult> {
  rethrowValidation(() => validateAmount(input.amount));
  const parsedDate = rethrowValidation(() => parseOccurredAt(input.scheduledDate));
  const normalizedNote = rethrowValidation(() => validateNote(input.note));

  return await withWorkspaceLock(input.workspaceId, async (tx) => {
    // Re-check category inside lock — defensive against archive race.
    const cat = await tx.category.findFirst({
      where: { id: input.categoryId, workspaceId: input.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!cat) throw new ScheduledSpendError("category_not_found");

    const row = await tx.scheduledSpend.create({
      data: {
        workspaceId: input.workspaceId,
        categoryId: input.categoryId,
        amount: new Prisma.Decimal(input.amount),
        scheduledDate: parsedDate,
        note: normalizedNote,
      },
      include: { matchedTx: { select: { removedAt: true } } },
    });
    // addScheduledSpendService doesn't accept userId; toDTO needs a "today"
    // for status derivation, but a freshly created schedule with no matchedTxId
    // and no dismissedAt always derives to "upcoming" (if scheduledDate >= today)
    // or "unresolved" (if past). For the add result we pass the workspace owner's
    // tz today via a fallback path — or accept that callers will re-list to get
    // the canonical status. For simplicity here use UTC midnight; the list
    // endpoint computes the correct tz-aware today.
    const utcToday = (() => {
      const n = new Date();
      return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
    })();
    return { schedule: toDTO(row, utcToday) };
  });
}

export type ListFilter = {
  from?: Date;
  to?: Date;
  status?: ScheduledSpendStatus | "all";
};

export type ListResult = {
  schedules: ScheduleDTO[];
};

export async function listScheduledSpendsService(
  ctx: { workspaceId: string; userId: string },
  filter: ListFilter,
): Promise<ListResult> {
  const where: Prisma.ScheduledSpendWhereInput = { workspaceId: ctx.workspaceId };
  if (filter.from || filter.to) {
    where.scheduledDate = {};
    if (filter.from) (where.scheduledDate as Prisma.DateTimeFilter).gte = filter.from;
    if (filter.to) (where.scheduledDate as Prisma.DateTimeFilter).lte = filter.to;
  }
  const rows = await prisma.scheduledSpend.findMany({
    where,
    orderBy: [{ scheduledDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    include: { matchedTx: { select: { removedAt: true } } },
  });

  const todayDateOnly = await todayDateOnlyForUser(ctx.userId);
  let dtos = rows.map((r) => toDTO(r, todayDateOnly));
  if (filter.status && filter.status !== "all") {
    dtos = dtos.filter((d) => d.status === filter.status);
  }
  return { schedules: dtos };
}

export type DismissResult =
  | { schedule: { id: string; dismissedAt: string } }
  | { dismissed: false; alreadyDismissed: true };

export async function dismissScheduledSpendService(
  ctx: { workspaceId: string },
  id: string,
): Promise<DismissResult> {
  return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const row = await tx.scheduledSpend.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      include: { matchedTx: { select: { removedAt: true } } },
    });
    if (!row) throw new ScheduledSpendError("not_found");
    if (row.dismissedAt !== null) {
      return { dismissed: false, alreadyDismissed: true } as const;
    }
    // Reject dismiss on active matched schedule (matched + matchedTx not soft-removed).
    if (row.matchedTxId && row.matchedTx && row.matchedTx.removedAt === null) {
      throw new ScheduledSpendError("already_matched");
    }

    const updated = await tx.scheduledSpend.update({
      where: { id },
      data: { dismissedAt: new Date() },
      select: { id: true, dismissedAt: true },
    });
    return { schedule: { id: updated.id, dismissedAt: updated.dismissedAt!.toISOString() } };
  });
}

export type RemoveResult =
  | { removed: true }
  | { removed: false; alreadyRemoved: true };

export async function removeScheduledSpendService(
  ctx: { workspaceId: string },
  id: string,
): Promise<RemoveResult> {
  return await withWorkspaceLock(ctx.workspaceId, async (tx) => {
    const result = await tx.scheduledSpend.deleteMany({
      where: { id, workspaceId: ctx.workspaceId },
    });
    if (result.count === 0) {
      return { removed: false, alreadyRemoved: true } as const;
    }
    return { removed: true } as const;
  });
}
