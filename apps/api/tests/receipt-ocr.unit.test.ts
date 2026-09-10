import { describe, expect, it } from "vitest";
import { normalizeOpenAiExpense, receiptOcrModel } from "../src/receipts/ocr.js";
import { receiptStorageLocation } from "../src/business/evidence.js";

describe("OpenAI receipt normalization", () => {
  it("normalizes exact cents, date, currency, and line items", () => {
    const normalized = normalizeOpenAiExpense({
      merchantName: "  Corner Store  ",
      receiptDate: "2026-08-24",
      currency: "cad",
      totalCents: 1234,
      subtotalCents: 1000,
      taxCents: 120,
      tipCents: 114,
      discountCents: null,
      lineItems: [{
        description: " Coffee ",
        quantity: "2",
        unitPriceCents: 500,
        lineTotalCents: 1000,
        page: 1,
      }],
    });

    expect(normalized).toMatchObject({ merchantName: "Corner Store", currency: "CAD" });
    expect(normalized.totalAmount?.toFixed(2)).toBe("12.34");
    expect(normalized.receiptDate?.toISOString()).toBe("2026-08-24T00:00:00.000Z");
    expect(normalized.lineItems[0]?.lineTotal.toFixed(2)).toBe("10.00");
    expect(normalized.lineItems[0]?.quantity?.toFixed(3)).toBe("2.000");
    expect(normalized.lineItems[0]?.unitPrice?.toFixed(2)).toBe("5.00");
    expect(normalized.lineItems[0]?.confidence).toBeNull();
  });

  it("rejects impossible dates instead of silently changing them", () => {
    expect(() => normalizeOpenAiExpense({
      merchantName: null,
      receiptDate: "2026-02-31",
      currency: null,
      totalCents: null,
      subtotalCents: null,
      taxCents: null,
      tipCents: null,
      discountCents: null,
      lineItems: [],
    })).toThrow("receipt_ocr_date_invalid");
  });

  it("defaults to Nano and promotes to Luna with one env value", () => {
    expect(receiptOcrModel({})).toBe("gpt-5-nano");
    expect(receiptOcrModel({ RECEIPT_OCR_MODEL: "gpt-5.6-luna" })).toBe("gpt-5.6-luna");
    expect(() => receiptOcrModel({ RECEIPT_OCR_MODEL: "gpt-5.6-sol" })).toThrow("receipt_ocr_model_not_supported");
  });

  it("maps tax country to the matching R2 bucket location", () => {
    expect(receiptStorageLocation("CA")).toBe("enam");
    expect(receiptStorageLocation("US")).toBe("us");
  });
});
