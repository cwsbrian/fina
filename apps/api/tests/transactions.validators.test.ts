import { describe, expect, it } from "vitest";
import {
  validateAmount,
  validateMerchantRaw,
  validateNote,
  parseOccurredAt,
  TxValidationError,
} from "../src/transactions/validators.js";

describe("validateAmount", () => {
  it("accepts 0.01", () => expect(() => validateAmount(0.01)).not.toThrow());
  it("accepts 999_999_999.99", () => expect(() => validateAmount(999_999_999.99)).not.toThrow());
  it("rejects 0", () => expect(() => validateAmount(0)).toThrow(TxValidationError));
  it("rejects negative", () => expect(() => validateAmount(-1)).toThrow(TxValidationError));
  it("rejects Infinity", () => expect(() => validateAmount(Number.POSITIVE_INFINITY)).toThrow(TxValidationError));
  it("rejects NaN", () => expect(() => validateAmount(Number.NaN)).toThrow(TxValidationError));
  it("rejects > max", () => expect(() => validateAmount(1_000_000_000)).toThrow(TxValidationError));
  it("rejects 0.005 (3 decimals)", () => expect(() => validateAmount(0.005)).toThrow(TxValidationError));
  it("rejects 1e20 (exceeds MAX_AMOUNT)", () => expect(() => validateAmount(1e20)).toThrow(TxValidationError));
  it("rejects 1e-7 (scientific notation in toString)", () => {
    // String(1e-7) === "1e-7" which fails the AMOUNT_RE digits-only check.
    expect(() => validateAmount(1e-7)).toThrow(TxValidationError);
  });
  it("error code is invalid_amount", () => {
    try { validateAmount(0); }
    catch (e) { expect((e as TxValidationError).code).toBe("invalid_amount"); }
  });
});

describe("parseOccurredAt", () => {
  it("accepts 2026-05-19", () => {
    const d = parseOccurredAt("2026-05-19");
    expect(d.toISOString().slice(0, 10)).toBe("2026-05-19");
  });
  it("anchors at UTC noon", () => {
    const d = parseOccurredAt("2026-05-19");
    expect(d.toISOString()).toBe("2026-05-19T12:00:00.000Z");
  });
  it("rejects 2026-13-01", () => expect(() => parseOccurredAt("2026-13-01")).toThrow(TxValidationError));
  it("rejects 2026-02-30 (impossible)", () => expect(() => parseOccurredAt("2026-02-30")).toThrow(TxValidationError));
  it("rejects empty", () => expect(() => parseOccurredAt("")).toThrow(TxValidationError));
  it("rejects ISO datetime", () => expect(() => parseOccurredAt("2026-05-19T00:00:00Z")).toThrow(TxValidationError));
  it("error code is invalid_date", () => {
    try { parseOccurredAt("bad"); }
    catch (e) { expect((e as TxValidationError).code).toBe("invalid_date"); }
  });
});

describe("validateMerchantRaw", () => {
  it("trims and returns", () => expect(validateMerchantRaw("  Costco  ")).toBe("Costco"));
  it("rejects empty after trim", () => expect(() => validateMerchantRaw("   ")).toThrow(TxValidationError));
  it("rejects 201 chars", () => expect(() => validateMerchantRaw("x".repeat(201))).toThrow(TxValidationError));
  it("accepts 200 chars", () => expect(() => validateMerchantRaw("x".repeat(200))).not.toThrow());
  it("error code is invalid_merchant", () => {
    try { validateMerchantRaw(""); }
    catch (e) { expect((e as TxValidationError).code).toBe("invalid_merchant"); }
  });
});

describe("validateNote", () => {
  it("returns null for undefined", () => expect(validateNote(undefined)).toBe(null));
  it("returns null for null", () => expect(validateNote(null)).toBe(null));
  it("accepts 1000 chars", () => expect(validateNote("x".repeat(1000))).toBe("x".repeat(1000)));
  it("rejects 1001 chars", () => expect(() => validateNote("x".repeat(1001))).toThrow(TxValidationError));
  it("accepts empty string", () => expect(validateNote("")).toBe(""));
  it("error code is invalid_note", () => {
    try { validateNote("x".repeat(1001)); }
    catch (e) { expect((e as TxValidationError).code).toBe("invalid_note"); }
  });
});
