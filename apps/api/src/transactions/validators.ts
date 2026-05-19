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

const MAX_AMOUNT = 999_999_999.99;
// Transaction.amount is Decimal(14, 2). Reject inputs that wouldn't round-trip
// cleanly at two decimal places. Cents-tolerance checks (e.g. cents - round < 1e-6)
// accept pathological inputs like 0.000000001 or 0.009999999999. Use the JS
// string serialization instead: the value must match
//   /^\d+(\.\d{1,2})?$/   (no scientific notation, ≤ 2 decimals)
const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

export function validateAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new TxValidationError("invalid_amount");
  }
  if (!AMOUNT_RE.test(String(amount))) {
    throw new TxValidationError("invalid_amount");
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseOccurredAt(s: string): Date {
  if (!DATE_RE.test(s)) throw new TxValidationError("invalid_date");
  const d = new Date(s + "T12:00:00Z");
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new TxValidationError("invalid_date");
  }
  return d;
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
