import type { Tier } from "../tier.js";
import type { SubscriptionDTO } from "./subscription.js";
import type { NotificationPrefs } from "../notifications.js";
import type { CategorizationMode } from "../categorization.js";
import type { UserRole } from "../user-role.js";

export type BillingRecoveryDTO = {
  locked: boolean;
  reason: "plan_mismatch" | null;
  source: SubscriptionDTO["source"] | null;
  action: "restore_iap" | "sync_stripe" | null;
  lastCheckedAt: string | null;
  boundAccountEmailMasked?: string | null;
};

/** Response of `GET /me`. Use this everywhere — never re-declare. */
export type MeDTO = {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: UserRole;
    tz: string;
    locale: string;
    /** Daily brief settings (Plan 2B). */
    morningTime: string;          // "HH:mm" 24h format
    snoozeUntil: string | null;   // ISO date string "YYYY-MM-DD" or null
    pauseEnabled: boolean;
    /** Per-type push notification prefs, fully resolved (server applies
     *  defaults so the client always sees every key). */
    notificationPrefs: NotificationPrefs;
    categorizationMode: CategorizationMode;
  };
  tier: Tier;
  trial: {
    active: boolean;
    /** ISO 8601 timestamp, or null if no trial scheduled. */
    endsAt: string | null;
  };
  /** Currently ACTIVE Stripe subscription (status in trialing/active/
   *  past_due), or null. Canceled / unpaid / incomplete rows are
   *  retained in DB for history but excluded from this field so the UI
   *  never accidentally shows Manage to a user whose sub is dead. */
  subscription: SubscriptionDTO | null;
  /** Source-agnostic billing lock/recovery state. Native IAP and Stripe use
   *  different recovery actions, but app lock decisions should use this shape. */
  billingRecovery: BillingRecoveryDTO;
  /** Native-store integrity guard. Webhooks remain the source of truth; this
   * only throttles occasional device-local checks and carries the global lock. */
  iapIntegrity: {
    isPlanMismatch: boolean;
    requiresCheck: boolean;
    lastCheckedAt: string | null;
  };
};
