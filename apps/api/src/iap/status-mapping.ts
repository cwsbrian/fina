// apps/api/src/iap/status-mapping.ts
import type { SubscriptionStatus } from "@fina/shared";

export type MappedStatus = { status: SubscriptionStatus; cancelAtPeriodEnd: boolean };

export type AppleStatusInput = {
  subscriptionStatus: "SUBSCRIBED" | "BILLING_RETRY" | "EXPIRED" | "REVOKED" | "PAUSED";
  /** ASC `signedRenewalInfo.offerType` — 1=intro, null=normal. */
  offerType?: number | null;
  /** 0 = auto-renew off, 1 = on. */
  autoRenewStatus?: 0 | 1;
};

export function mapAppleStatus(a: AppleStatusInput): MappedStatus {
  if (a.subscriptionStatus === "SUBSCRIBED") {
    // Intro / trial offer present → trialing. Fail closed on unknown offerType.
    if (a.offerType != null) return { status: "trialing", cancelAtPeriodEnd: false };
    const cancelAtPeriodEnd = a.autoRenewStatus === 0;
    return { status: "active", cancelAtPeriodEnd };
  }
  if (a.subscriptionStatus === "BILLING_RETRY") return { status: "past_due", cancelAtPeriodEnd: false };
  if (a.subscriptionStatus === "PAUSED") return { status: "paused", cancelAtPeriodEnd: false };
  return { status: "canceled", cancelAtPeriodEnd: false }; // EXPIRED | REVOKED
}

export type GoogleStatusInput = {
  subscriptionState:
    | "SUBSCRIPTION_STATE_ACTIVE"
    | "SUBSCRIPTION_STATE_IN_GRACE_PERIOD"
    | "SUBSCRIPTION_STATE_ON_HOLD"
    | "SUBSCRIPTION_STATE_PAUSED"
    | "SUBSCRIPTION_STATE_EXPIRED"
    | "SUBSCRIPTION_STATE_CANCELED"
    | "SUBSCRIPTION_STATE_PENDING";
  expiryTime: Date;
  /** v2 lineItems[].offerDetails.offerId — non-null when intro/trial active. */
  introOffer?: boolean;
};

export function mapGoogleStatus(g: GoogleStatusInput): MappedStatus {
  const now = Date.now();
  const expired = g.expiryTime.getTime() <= now;
  switch (g.subscriptionState) {
    case "SUBSCRIPTION_STATE_ACTIVE":
      if (g.introOffer) return { status: "trialing", cancelAtPeriodEnd: false };
      return { status: "active", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
    case "SUBSCRIPTION_STATE_ON_HOLD":
      return { status: "past_due", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_PAUSED":
      return { status: "paused", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_CANCELED":
      if (expired) return { status: "canceled", cancelAtPeriodEnd: false };
      return { status: "active", cancelAtPeriodEnd: true };
    case "SUBSCRIPTION_STATE_PENDING":
      return { status: "incomplete", cancelAtPeriodEnd: false };
    case "SUBSCRIPTION_STATE_EXPIRED":
    default:
      return { status: "canceled", cancelAtPeriodEnd: false };
  }
}
