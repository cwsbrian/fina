import { z } from "zod";

export const RECEIPT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "application/pdf",
  "image/tiff",
] as const;

export const ReceiptRoleSchema = z.enum(["payment_proof", "itemized", "combined"]);

export const CreateReceiptUploadIntentBody = z.object({
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.enum(RECEIPT_MIME_TYPES),
  byteSize: z.number().int().positive().max(25 * 1024 * 1024),
  pageCount: z.number().int().min(1).max(20).optional(),
  role: ReceiptRoleSchema,
  transactionId: z.string().min(1).optional(),
  supersedesReceiptId: z.string().min(1).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
}).superRefine((value, ctx) => {
  const isMultiPage = value.mimeType === "application/pdf" || value.mimeType === "image/tiff";
  if (!isMultiPage && value.byteSize > 10 * 1024 * 1024) {
    ctx.addIssue({ code: "custom", path: ["byteSize"], message: "single_page_too_large" });
  }
});

export const CompleteReceiptUploadBody = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  byteSize: z.number().int().positive(),
});

export const PatchReceiptBody = z.object({
  role: ReceiptRoleSchema.optional(),
  merchantName: z.string().trim().max(200).nullable().optional(),
  receiptDate: z.string().datetime().nullable().optional(),
  totalAmount: z.number().finite().min(0).nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  lineItems: z.array(z.object({
    id: z.string().min(1).optional(),
    description: z.string().trim().min(1).max(500),
    quantity: z.number().positive().nullable().optional(),
    unitPrice: z.number().finite().nullable().optional(),
    lineTotal: z.number().finite().min(0),
    categoryId: z.string().min(1).nullable().optional(),
  })).optional(),
  reviewed: z.boolean().optional(),
});

export const LinkReceiptBody = z.object({ transactionId: z.string().min(1) });

export const CreateTransactionFromReceiptBody = z.object({
  accountId: z.string().min(1),
  merchant: z.string().trim().min(1).max(200).optional(),
  occurredAt: z.string().datetime().optional(),
  totalAmount: z.number().positive().optional(),
});

const ReceiptApplyItem = z.object({
  lineItemId: z.string().min(1),
  categoryId: z.string().min(1).nullable(),
  businessAmount: z.number().finite().min(0),
});

export const ApplyReceiptBody = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("whole"),
    transactionId: z.string().min(1),
    expectedTransactionVersion: z.number().int().positive(),
    categoryId: z.string().min(1).nullable(),
    businessAmount: z.number().finite().min(0).optional(),
  }),
  z.object({
    mode: z.literal("items"),
    transactionId: z.string().min(1),
    expectedTransactionVersion: z.number().int().positive(),
    items: z.array(ReceiptApplyItem).min(1),
  }),
]);

export type CreateReceiptUploadIntentInput = z.infer<typeof CreateReceiptUploadIntentBody>;
export type PatchReceiptInput = z.infer<typeof PatchReceiptBody>;
export type ApplyReceiptInput = z.infer<typeof ApplyReceiptBody>;
