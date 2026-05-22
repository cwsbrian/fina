import type { PaidTier } from "../pricing.js";

/** Mirrors every status Stripe can send so MeDTO.subscription.status
 * can be written verbatim by the webhook. Only the first three count
 * as "active" for EffectiveTier — see apps/api/src/auth/tier.ts. */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";

export const ACTIVE_SUBSCRIPTION_STATUSES: ReadonlyArray<SubscriptionStatus> = [
  "trialing",
  "active",
  "past_due",
];

/** Source-agnostic — only "stripe" populated in v1. iap_* future-proof. */
export type SubscriptionSource = "stripe" | "iap_apple" | "iap_google";

/** Exposed on MeDTO.subscription. Only carries ACTIVE subs (see
 * ACTIVE_SUBSCRIPTION_STATUSES) — canceled rows return null on the wire. */
export type SubscriptionDTO = {
  tier: PaidTier;
  status: SubscriptionStatus;
  /** ISO-8601 from Stripe's current_period_end. */
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  source: SubscriptionSource;
  /** When a tier change is scheduled at the next period boundary (Portal
   *  "downgrade at period end" or our /billing/change-tier downgrade
   *  flow), this names the tier the user will switch to. Null when no
   *  scheduled change. */
  pendingTier: PaidTier | null;
  /** ISO-8601 when the scheduled change takes effect — usually equals
   *  currentPeriodEnd. Null when no scheduled change. */
  pendingTierAt: string | null;
};
