import { z } from "zod";

/** POST /workspaces/:id/transactions/manual */
export const ManualTransactionBody = z.object({
  merchantRaw: z.string().trim().min(1),
  amount: z.number().finite(),
  currency: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/))
    .optional(),
  occurredAt: z.string().optional(),
  categoryId: z.string().optional(),
  note: z.string().optional(),
  accountId: z.string().optional(),
});
