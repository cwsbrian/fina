import type { ReceiptDocument, Transaction, Workspace } from "@prisma/client";
import type { EvidenceStatus } from "@fina/shared";

type EvidenceTransaction = Pick<
  Transaction,
  "source" | "postedAt" | "pending" | "receiptMissingReason"
> & { receipts: Array<Pick<ReceiptDocument, "role" | "status" | "merchantName" | "receiptDate" | "totalAmount" | "deletedAt" | "verifiedAt"> & { lineItems: Array<{ id: string }> }> };

export function evidenceStatus(transaction: EvidenceTransaction): EvidenceStatus {
  const receipts = transaction.receipts.filter((r) =>
    !r.deletedAt && r.status !== "deleted" && r.status !== "superseded",
  );
  const paymentFromBank = transaction.source === "plaid" && !transaction.pending && transaction.postedAt !== null;
  const paymentFromDocument = receipts.some((r) =>
    (r.role === "payment_proof" || r.role === "combined") &&
    r.verifiedAt !== null && r.status === "reviewed" && r.merchantName !== null && r.receiptDate !== null && r.totalAmount !== null,
  );
  const itemDetail = receipts.some((r) =>
    (r.role === "itemized" || r.role === "combined") && r.verifiedAt !== null && r.status === "reviewed" && r.lineItems.length > 0,
  );
  const awaitingOcr = receipts.some((r) =>
    (r.role === "itemized" || r.role === "combined") &&
    ["queued", "processing", "ocr_review", "failed"].includes(r.status),
  );

  if ((paymentFromBank || paymentFromDocument) && itemDetail) return "complete";
  if (transaction.receiptMissingReason) return "documented_missing";
  if (awaitingOcr) return "ocr_review";
  if (!paymentFromBank && !paymentFromDocument) return "needs_payment_proof";
  return "needs_itemized";
}

export function receiptStorageLocation(country: Workspace["taxCountry"]): "enam" | "us" {
  return country === "US" ? "us" : "enam";
}
