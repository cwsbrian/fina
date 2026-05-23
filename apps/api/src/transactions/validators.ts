import { MAX_AMOUNT, AMOUNT_RE, DATE_RE, ISO_INSTANT_RE } from "@fina/shared";

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

export function parseOccurredAt(s: string): Date {
  // Accept either YYYY-MM-DD (legacy) or full ISO 8601 with tz so
  // manual transactions can carry the user-chosen time. Mirrors shared
  // validation/dates.parseOccurredAt.
  if (DATE_RE.test(s)) {
    const d = new Date(s + "T12:00:00Z");
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
      throw new TxValidationError("invalid_date");
    }
    return d;
  }
  if (ISO_INSTANT_RE.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new TxValidationError("invalid_date");
    return d;
  }
  throw new TxValidationError("invalid_date");
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
