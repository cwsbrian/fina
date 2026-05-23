import {
  MAX_AMOUNT,
  AMOUNT_RE,
  parseOccurredAt as parseOccurredAtShared,
  DateValidationError,
} from "@fina/shared";

export type TxValidationCode =
  | "invalid_amount"
  | "invalid_date"
  | "invalid_merchant"
  | "invalid_note";

export class TxValidationError extends Error {
  readonly code: TxValidationCode;
  constructor(code: TxValidationCode) {
    super(code);
    this.name = "TxValidationError";
    this.code = code;
  }
}

export function validateAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new TxValidationError("invalid_amount");
  }
  if (!AMOUNT_RE.test(String(amount))) {
    throw new TxValidationError("invalid_amount");
  }
}

// Thin wrapper that re-emits the shared parser's DateValidationError as
// our local TxValidationError so callers only have to catch one type.
export function parseOccurredAt(s: string): Date {
  try {
    return parseOccurredAtShared(s);
  } catch (e) {
    if (e instanceof DateValidationError) {
      throw new TxValidationError("invalid_date");
    }
    throw e;
  }
}

export function validateMerchantRaw(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new TxValidationError("invalid_merchant");
  }
  return trimmed;
}

export function validateNote(note: string | null | undefined): string | null {
  if (note === undefined || note === null) return null;
  if (note.length > 1000) throw new TxValidationError("invalid_note");
  return note;
}
