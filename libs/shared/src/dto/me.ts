import type { Tier } from "../tier.js";
import type { SubscriptionDTO } from "./subscription.js";

/** Response of `GET /me`. Use this everywhere — never re-declare. */
export type MeDTO = {
  user: {
    id: string;
    email: string;
    name: string | null;
    tz: string;
    locale: string;
    /** Daily brief settings (Plan 2B). */
    morningTime: string;          // "HH:mm" 24h format
    snoozeUntil: string | null;   // ISO date string "YYYY-MM-DD" or null
    pauseEnabled: boolean;
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
};
