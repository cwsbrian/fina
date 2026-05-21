import { z } from "zod";
import { PAID_TIERS } from "../pricing.js";

/** Request body for POST /billing/checkout. */
export const CheckoutBody = z.object({
  tier: z.enum(PAID_TIERS),
});
export type CheckoutBody = z.infer<typeof CheckoutBody>;

/** Request body for POST /billing/sync. sessionId is the
 * {CHECKOUT_SESSION_ID} substituted into the success_url so the API
 * can resolve the session even when stripeCustomerId is still null. */
export const SyncBody = z.object({
  sessionId: z.string().min(1).optional(),
});
export type SyncBody = z.infer<typeof SyncBody>;
