import Stripe from "stripe";
import type { Env } from "../env.js";

// Lazy singleton mirrors apps/api/src/plaid/client.ts. Cache key includes
// the secret so a test that flips STRIPE_SECRET_KEY between buildApp()
// calls doesn't silently reuse a client configured with the old secret.
let cached: Stripe | null = null;
let cachedFor: string | null = null;

export function stripeClient(env: Env): Stripe {
  const cacheKey = env.STRIPE_SECRET_KEY;
  if (cached && cachedFor === cacheKey) return cached;
  // stripe@17.7.0 LatestApiVersion is '2025-02-24.acacia', not '2025-04-30.basil'.
  // Omitting apiVersion lets the SDK default to its own LatestApiVersion,
  // which is pinned per SDK release — upgrades are explicit via pnpm update.
  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    typescript: true,
  });
  cachedFor = cacheKey;
  return cached;
}

// Test-only — clears the cache so a new env produces a new client.
export function _clearStripeClientCache(): void {
  cached = null;
  cachedFor = null;
}
