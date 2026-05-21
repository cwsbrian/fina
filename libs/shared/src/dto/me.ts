import type { Tier } from "../tier.js";

/** Response of `GET /me`. Use this everywhere — never re-declare. */
export type MeDTO = {
  user: {
    id: string;
    email: string;
    name: string | null;
    tz: string;
    locale: string;
  };
  tier: Tier;
  trial: {
    active: boolean;
    /** ISO 8601 timestamp, or null if no trial scheduled. */
    endsAt: string | null;
  };
};
