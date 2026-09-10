export type EvidenceStatus =
  | "complete"
  | "needs_itemized"
  | "needs_payment_proof"
  | "ocr_review"
  | "documented_missing";

export type BusinessExpenseRow = {
  transactionId: string;
  version: number;
  merchant: string;
  occurredAt: string;
  totalAmount: string;
  businessAmount: string | null;
  currency: string;
  partial: boolean;
  evidenceStatus: EvidenceStatus;
  expenseReview: boolean;
  unreviewedAmount: string;
};

export type BusinessOverview = {
  yearMonth: string;
  currency: string;
  incomeRecorded: string;
  confirmedBusinessExpenses: string;
  incomeMinusConfirmedExpenses: string;
  expenseReviewAmount: string;
  expenseReviewCount: number;
  missingEvidenceCount: number;
  hasUnreviewedTransactions: boolean;
  recentExpenses: BusinessExpenseRow[];
};

export type ReceiptLineItemDTO = {
  id: string;
  description: string;
  quantity: string | null;
  unitPrice: string | null;
  lineTotal: string;
  confidence: number | null;
  page: number;
  boundingBox: unknown | null;
  categoryId: string | null;
};

export type ReceiptDocumentDTO = {
  id: string;
  transactionId: string | null;
  role: "payment_proof" | "itemized" | "combined";
  status: "uploading" | "queued" | "processing" | "ocr_review" | "reviewed" | "failed" | "superseded" | "deleted";
  originalName: string;
  mimeType: string;
  byteSize: number;
  pageCount: number | null;
  sha256: string | null;
  verifiedAt: string | null;
  merchantName: string | null;
  receiptDate: string | null;
  totalAmount: string | null;
  currency: string | null;
  lineItems: ReceiptLineItemDTO[];
  createdAt: string;
};
