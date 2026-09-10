import { describe, expect, it } from "vitest";
import { CreateReceiptUploadIntentBody, CreateWorkspaceBody } from "@fina/shared";
import { evidenceStatus } from "../src/business/evidence.js";
import { allocateProportionalCents } from "../src/business/proportional.js";

function transaction(overrides: Record<string, unknown> = {}) {
  return {
    source: "plaid",
    postedAt: new Date("2026-08-01T00:00:00Z"),
    pending: false,
    receiptMissingReason: null,
    receipts: [],
    ...overrides,
  } as Parameters<typeof evidenceStatus>[0];
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    role: "itemized",
    status: "reviewed",
    merchantName: "Store",
    receiptDate: new Date("2026-08-01T00:00:00Z"),
    totalAmount: { toString: () => "10.00" },
    deletedAt: null,
    verifiedAt: new Date("2026-08-01T00:00:00Z"),
    lineItems: [{ id: "line-1" }],
    ...overrides,
  } as never;
}

describe("business evidence", () => {
  it("accepts a posted Plaid transaction plus reviewed item detail", () => {
    expect(evidenceStatus(transaction({ receipts: [receipt()] }))).toBe("complete");
  });

  it("requires payment proof for a manual transaction", () => {
    expect(evidenceStatus(transaction({ source: "manual", postedAt: null, receipts: [receipt()] }))).toBe("needs_payment_proof");
  });

  it("combined evidence satisfies both roles when its summary was reviewed", () => {
    expect(evidenceStatus(transaction({ source: "manual", postedAt: null, receipts: [receipt({ role: "combined" })] }))).toBe("complete");
  });

  it("keeps a documented missing record distinct from complete evidence", () => {
    expect(evidenceStatus(transaction({ source: "manual", postedAt: null, receiptMissingReason: "merchant_did_not_provide" }))).toBe("documented_missing");
  });

  it("surfaces OCR review before item evidence can be complete", () => {
    expect(evidenceStatus(transaction({ receipts: [receipt({ status: "ocr_review" })] }))).toBe("ocr_review");
  });

  it("never treats an unverified or empty itemized upload as complete", () => {
    expect(evidenceStatus(transaction({ receipts: [receipt({ verifiedAt: null })] }))).toBe("needs_itemized");
    expect(evidenceStatus(transaction({ receipts: [receipt({ lineItems: [] })] }))).toBe("needs_itemized");
  });
});

describe("receipt allocation and validation", () => {
  it("rounds cents deterministically and preserves the transaction total", () => {
    const result = allocateProportionalCents([{ id: "a", cents: 100 }, { id: "b", cents: 100 }, { id: "c", cents: 100 }], 1000);
    expect([...result.values()].reduce((sum, value) => sum + value, 0)).toBe(1000);
    expect(result.get("a")).toBe(334);
    expect(result.get("b")).toBe(333);
  });

  it("requires tax country for business workspaces", () => {
    expect(CreateWorkspaceBody.safeParse({ name: "Studio", kind: "business" }).success).toBe(false);
    expect(CreateWorkspaceBody.safeParse({ name: "Studio", kind: "business", taxCountry: "CA" }).success).toBe(true);
  });

  it("enforces conservative single-page and multi-page limits", () => {
    expect(CreateReceiptUploadIntentBody.safeParse({ originalName: "a.jpg", mimeType: "image/jpeg", byteSize: 10 * 1024 * 1024 + 1, role: "combined" }).success).toBe(false);
    expect(CreateReceiptUploadIntentBody.safeParse({ originalName: "a.pdf", mimeType: "application/pdf", byteSize: 20 * 1024 * 1024, pageCount: 21, role: "itemized" }).success).toBe(false);
  });
});
