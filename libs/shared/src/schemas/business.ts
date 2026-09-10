import { z } from "zod";

const money = z.number().finite().min(0).max(99_999_999_999.99);

export const BusinessAllocationInput = z.object({
  allocationId: z.string().min(1).optional(),
  categoryId: z.string().min(1).nullable(),
  amount: z.number().finite().refine((n) => n !== 0),
  businessAmount: money.nullable(),
  receiptLineItemId: z.string().min(1).nullable().optional(),
});

export const PutBusinessUseBody = z.object({
  expectedVersion: z.number().int().positive(),
  allocations: z.array(BusinessAllocationInput).min(1),
  businessPurpose: z.string().trim().max(500).nullable().optional(),
  receiptMissingReason: z.string().trim().max(120).nullable().optional(),
  receiptMissingNote: z.string().trim().max(500).nullable().optional(),
});

export type PutBusinessUseInput = z.infer<typeof PutBusinessUseBody>;
