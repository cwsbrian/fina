# Billing — Stripe Integration (Lite + Pro) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`docs/superpowers/specs/2026-05-21-billing-stripe-design.md`](../specs/2026-05-21-billing-stripe-design.md)
**Codex review:** [`docs/superpowers/plans/2026-05-21-billing-stripe-codex-review.md`](./2026-05-21-billing-stripe-codex-review.md) (passes 1–7, 8 findings resolved).

**Goal:** Replace the trial-only Pro stub with real Stripe-billed Lite ($7 CAD/mo) and Pro ($15 CAD/mo) subscriptions, with Stripe Customer Portal handling cancel / card / invoices, and `EffectiveTier` reflecting paid status after the 30-day trial ends.

**Architecture:** Source-agnostic `Subscription` table on User (1:N). All subscription-touching webhooks re-fetch from Stripe and UPSERT (order-independent). Customer is created + persisted BEFORE Checkout to avoid duplicate-billing races. `/billing/sync` bridges the Checkout success redirect vs webhook race. `MeDTO.subscription` carries only active subs (`trialing/active/past_due`); canceled rows are retained for history.

**Tech Stack:** Fastify, Prisma, Postgres, Stripe Node SDK (`stripe@^17`), Next.js (Web), `@fina/shared`. Tests use vitest + real Postgres + module-mocked Stripe client.

---

## File structure

### Shared lib (`libs/shared/`)
- Create `src/pricing.ts` — `PRICING` constant (display prices).
- Create `src/dto/subscription.ts` — `SubscriptionDTO`, `SubscriptionStatus`, `SubscriptionSource`.
- Create `src/schemas/billing.ts` — zod schemas `CheckoutBody`, `SyncBody`.
- Modify `src/dto/me.ts` — add `subscription: SubscriptionDTO | null` to `MeDTO`.
- Modify `src/errors.ts` — add 5 error codes to `API_ERROR_CODES`.
- Modify `src/index.ts` — re-export new modules.

### API (`apps/api/`)
- Modify `prisma/schema.prisma` — `Subscription`, `WebhookEvent`, `User.stripeCustomerId`.
- Modify `src/env.ts` — 4 new `STRIPE_*` env vars.
- Modify `package.json` — add `stripe` dep.
- Create `src/stripe/client.ts` — lazy Stripe SDK singleton (mirrors `plaid/client.ts`).
- Create `src/stripe/pricing-map.ts` — `priceIdForTier` / `tierForPriceId`.
- Create `src/stripe/ensure-customer.ts` — `ensureStripeCustomer(user)` with idempotency key.
- Create `src/stripe/sync-sub.ts` — `syncSubscriptionFromStripe(subId, userId)` re-fetch + upsert helper.
- Create `src/routes/billing.ts` — `/billing/checkout`, `/billing/portal`, `/billing/sync`.
- Create `src/routes/billing-webhook.ts` — `POST /webhooks/stripe` (raw-body, signature, idempotency, event dispatch).
- Modify `src/auth/tier.ts` — `computeEffectiveTier` consults active subs.
- Modify `src/routes/me.ts` — build `subscription` field (active subs only).
- Modify `src/server.ts` — register billing routes + content-type parser for webhook raw body.
- Create test files per task.

### Web (`apps/web/`)
- Modify `src/app/(app)/settings/plan/page.tsx` — wire to new API, decision matrix UI, `?sessionId=` handling.

### Docs / Env
- Modify `apps/api/.env.example` — add 4 Stripe vars.
- Modify `README.md` — Stripe local setup section.

---

## Task 1: Shared lib — pricing, SubscriptionDTO, error codes, zod schemas

**Files:**
- Create: `libs/shared/src/pricing.ts`
- Create: `libs/shared/src/dto/subscription.ts`
- Create: `libs/shared/src/schemas/billing.ts`
- Modify: `libs/shared/src/dto/me.ts`
- Modify: `libs/shared/src/errors.ts`
- Modify: `libs/shared/src/index.ts`

- [ ] **Step 1: Create `libs/shared/src/pricing.ts`**

```ts
/** Display prices for the /settings/plan comparison table and any other
 * pricing copy. Stripe Price IDs live in apps/api env (STRIPE_PRICE_*);
 * this file is the single source of truth for human-readable amounts. */
export const PRICING = {
  lite: { monthlyCAD: 7, displayPrice: "$7" },
  pro: { monthlyCAD: 15, displayPrice: "$15" },
} as const;

export type PaidTier = keyof typeof PRICING; // "lite" | "pro"
```

- [ ] **Step 2: Create `libs/shared/src/dto/subscription.ts`**

```ts
/** Mirrors every status Stripe can send so MeDTO.subscription.status
 * can be written verbatim by the webhook. Only the first three count
 * as "active" for EffectiveTier — see auth/tier.ts. */
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
  tier: "lite" | "pro";
  status: SubscriptionStatus;
  /** ISO-8601 from Stripe's current_period_end. */
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  source: SubscriptionSource;
};
```

- [ ] **Step 3: Create `libs/shared/src/schemas/billing.ts`**

```ts
import { z } from "zod";

/** Request body for POST /billing/checkout. */
export const CheckoutBody = z.object({
  tier: z.enum(["lite", "pro"]),
});
export type CheckoutBody = z.infer<typeof CheckoutBody>;

/** Request body for POST /billing/sync. sessionId is the
 * {CHECKOUT_SESSION_ID} substituted into the success_url so the API
 * can resolve the session even when stripeCustomerId is still null. */
export const SyncBody = z.object({
  sessionId: z.string().optional(),
});
export type SyncBody = z.infer<typeof SyncBody>;
```

- [ ] **Step 4: Modify `libs/shared/src/dto/me.ts` — add subscription field**

Read the file first to see exact shape. Then add:

```ts
// at top
import type { SubscriptionDTO } from "./subscription.js";
```

In the `MeDTO` type, after `trial`, add:

```ts
  /** Currently ACTIVE Stripe subscription (status in trialing/active/
   *  past_due), or null. Canceled / unpaid / incomplete rows are
   *  retained in DB for history but excluded from this field so the UI
   *  never accidentally shows Manage to a user whose sub is dead. */
  subscription: SubscriptionDTO | null;
```

- [ ] **Step 5: Modify `libs/shared/src/errors.ts` — add 5 codes**

Find `API_ERROR_CODES` and add:

```ts
  "payment_required",
  "checkout_failed",
  "portal_failed",
  "webhook_invalid_signature",
  "already_subscribed",
```

(Keep the rest of the union untouched.)

- [ ] **Step 6: Re-export from `libs/shared/src/index.ts`**

Append:

```ts
export * from "./pricing.js";
export * from "./dto/subscription.js";
export * from "./schemas/billing.js";
```

- [ ] **Step 7: Typecheck shared lib**

Run: `pnpm --filter @fina/shared exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add libs/shared/src/pricing.ts libs/shared/src/dto/subscription.ts libs/shared/src/schemas/billing.ts libs/shared/src/dto/me.ts libs/shared/src/errors.ts libs/shared/src/index.ts
git commit -m "feat(@fina/shared): add billing primitives (PRICING, SubscriptionDTO, schemas, errors)

Shipping shared lib first so apps/api and apps/web can both import
the same SubscriptionDTO / CheckoutBody / PRICING. No consumers in
this commit — wiring lands in the API + web tasks that follow.

- src/pricing.ts: PRICING with display prices for Lite ($7) and Pro ($15).
- src/dto/subscription.ts: SubscriptionDTO + 8 Stripe statuses + helper
  ACTIVE_SUBSCRIPTION_STATUSES (the three that count as 'active' for
  EffectiveTier).
- src/schemas/billing.ts: CheckoutBody (tier enum) + SyncBody (optional
  sessionId from Checkout success redirect).
- src/dto/me.ts: MeDTO.subscription field (active sub or null).
- src/errors.ts: payment_required, checkout_failed, portal_failed,
  webhook_invalid_signature, already_subscribed.

Per CLAUDE.md the shared lib goes first; the TS compiler will guide
the per-app wiring next."
```

---

## Task 2: Prisma — Subscription, WebhookEvent, User.stripeCustomerId

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Generated: `apps/api/prisma/migrations/<timestamp>_billing/migration.sql`

- [ ] **Step 1: Add enums + models to `apps/api/prisma/schema.prisma`**

Find the section near other enums (e.g. after `PlaidItemStatus`) and add:

```prisma
// Mirrors every status Stripe can send so the webhook can write the
// value verbatim without enum-validation failures. Only `trialing` /
// `active` / `past_due` count as active for EffectiveTier — see
// auth/tier.ts.
enum SubscriptionStatus {
  trialing
  active
  past_due
  canceled
  unpaid               // final state after Smart Retries exhausted
  incomplete           // first invoice never settled
  incomplete_expired   // Checkout abandoned, auto-canceled by Stripe
  paused               // admin-paused; rare
}

// Source-agnostic per design spec §13.7. Only `stripe` populated in
// v1; iap_* future-proof for the mobile billing PR.
enum SubscriptionSource {
  stripe
  iap_apple
  iap_google
}
```

Then add the two new models (place near `PlaidItem` / `User` for proximity):

```prisma
model Subscription {
  id                     String             @id @default(cuid())
  userId                 String
  user                   User               @relation(fields: [userId], references: [id], onDelete: Cascade)

  // "lite" | "pro" — String not Prisma enum because it must match
  // @fina/shared Tier union (free|lite|pro) exactly. Validated by
  // tierForPriceId() at write boundaries; free never appears here.
  tier                   String
  source                 SubscriptionSource
  // Stripe "sub_..."
  sourceSubscriptionId   String
  // Stripe "cus_..."; mirrors User.stripeCustomerId for query convenience.
  sourceCustomerId       String?

  status                 SubscriptionStatus
  currentPeriodEnd       DateTime
  cancelAtPeriodEnd      Boolean            @default(false)
  // "monthly" | "annual" — annual deferred to v1.5+ per spec.
  billingPeriod          String             @default("monthly")

  createdAt              DateTime           @default(now())
  updatedAt              DateTime           @updatedAt

  @@unique([source, sourceSubscriptionId])
  @@index([userId, status])
  @@map("subscriptions")
}

// Stores enough to dedupe; no body retained (PII + volume).
model WebhookEvent {
  // Stripe event.id ("evt_...") — also serves as idempotency key.
  id          String   @id
  source      String
  type        String
  receivedAt  DateTime @default(now())

  @@index([source, type])
  @@map("webhook_events")
}
```

In `model User`, add the new field + back-relation. Locate the existing User block and add inside it:

```prisma
  stripeCustomerId  String?  @unique
  subscriptions     Subscription[]
```

- [ ] **Step 2: Generate migration**

Run: `pnpm --filter @fina/api exec prisma migrate dev --name billing --create-only`
Expected: a new file `apps/api/prisma/migrations/<ts>_billing/migration.sql` is created. Do NOT apply yet (`--create-only`). Open it and verify it contains:
- `CREATE TYPE "SubscriptionStatus" AS ENUM (...)` with all 8 values.
- `CREATE TYPE "SubscriptionSource" AS ENUM (...)`.
- `CREATE TABLE "subscriptions" (...)` with `@@unique([source, sourceSubscriptionId])` rendered as a unique index.
- `CREATE TABLE "webhook_events" (...)`.
- `ALTER TABLE "users" ADD COLUMN "stripeCustomerId" TEXT` + unique index.

- [ ] **Step 3: Apply migration**

Run: `pnpm --filter @fina/api exec prisma migrate dev`
Expected: migration applied to the local dev DB (port 5433). `prisma generate` runs automatically.

- [ ] **Step 4: Smoke-check via psql**

Run: `docker exec fina-postgres-dev psql -U fina -d fina -c '\d subscriptions'`
Expected: table exists with columns `id, userId, tier, source, sourceSubscriptionId, sourceCustomerId, status, currentPeriodEnd, cancelAtPeriodEnd, billingPeriod, createdAt, updatedAt`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(api): Prisma schema for Subscription + WebhookEvent

- Subscription (User 1:N) with @@unique(source, sourceSubscriptionId)
  to handle webhook retry races and @@index(userId, status) for the
  active-sub lookup in EffectiveTier.
- WebhookEvent stores event.id + source + type (no body) for
  idempotency dedupe.
- User.stripeCustomerId unique — one Stripe Customer per user.
- SubscriptionStatus enum mirrors Stripe's 8 statuses 1:1 so the
  webhook can upsert any value without Prisma validation failure.
- SubscriptionSource enum is source-agnostic; iap_* future-proof."
```

---

## Task 3: API env, Stripe SDK, client + helpers

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/env.ts`
- Create: `apps/api/src/stripe/client.ts`
- Create: `apps/api/src/stripe/pricing-map.ts`
- Create: `apps/api/src/stripe/ensure-customer.ts`
- Create: `apps/api/src/stripe/sync-sub.ts`

- [ ] **Step 1: Install Stripe SDK**

Run: `pnpm --filter @fina/api add stripe@^17`
Expected: `apps/api/package.json` gets `"stripe": "^17.x"`.

- [ ] **Step 2: Add Stripe env vars to `apps/api/src/env.ts`**

Inside the `Schema` object, add (anywhere among the other vars):

```ts
  STRIPE_SECRET_KEY: z.string(),
  STRIPE_WEBHOOK_SECRET: z.string(),
  STRIPE_PRICE_LITE_MONTHLY: z.string(),
  STRIPE_PRICE_PRO_MONTHLY: z.string(),
```

`WEB_APP_URL` is already declared — reused for `success_url` / `cancel_url` / `return_url`.

- [ ] **Step 3: Update existing test env helpers**

Find every test file with an `env = { ... }` literal that omits the new Stripe vars; the test suite will fail loud now if any zod-required field is absent. Add Stripe defaults to each:

```ts
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
```

Locate them with: `grep -rln "PLAID_CLIENT_ID:" apps/api/tests/`. Edit each to add the four fields.

- [ ] **Step 4: Create `apps/api/src/stripe/client.ts`**

```ts
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
  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    // Pin so SDK upgrades don't change webhook payload shape unexpectedly.
    apiVersion: "2025-04-30.basil",
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
```

- [ ] **Step 5: Create `apps/api/src/stripe/pricing-map.ts`**

```ts
import type { Env } from "../env.js";
import type { PaidTier } from "@fina/shared";

/** tier → Stripe price ID. Throws if env is missing the mapping
 * (should never happen because env zod requires both). */
export function priceIdForTier(env: Env, tier: PaidTier): string {
  if (tier === "lite") return env.STRIPE_PRICE_LITE_MONTHLY;
  if (tier === "pro") return env.STRIPE_PRICE_PRO_MONTHLY;
  // Exhaustiveness — keeps TS happy if PaidTier ever grows.
  const _exhaustive: never = tier;
  throw new Error(`Unknown tier for pricing map: ${_exhaustive}`);
}

/** Stripe price ID → tier. Returns null for unknown IDs; webhook
 * handler logs + returns 200 in that case (prevents Stripe retry storm). */
export function tierForPriceId(env: Env, priceId: string): PaidTier | null {
  if (priceId === env.STRIPE_PRICE_LITE_MONTHLY) return "lite";
  if (priceId === env.STRIPE_PRICE_PRO_MONTHLY) return "pro";
  return null;
}
```

- [ ] **Step 6: Create `apps/api/src/stripe/ensure-customer.ts`**

```ts
import type { Env } from "../env.js";
import type { User } from "@prisma/client";
import { prisma } from "../db.js";
import { stripeClient } from "./client.js";

/** Lazy create + persist a Stripe Customer for the user. Idempotent
 * across retries via Idempotency-Key: a DB-write failure between
 * stripe.customers.create() and prisma.user.update() doesn't orphan
 * a customer — the next call returns the same Stripe Customer.
 *
 * MUST be called before stripe.checkout.sessions.create() so the
 * session uses `customer: <id>` rather than `customer_email`, which
 * would create a fresh Customer record on every concurrent Checkout. */
export async function ensureStripeCustomer(env: Env, user: User): Promise<string> {
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const stripe = stripeClient(env);
  const customer = await stripe.customers.create(
    {
      email: user.email,
      name: user.name ?? undefined,
      metadata: { fina_user_id: user.id },
    },
    { idempotencyKey: `customer-create-${user.id}` },
  );
  await prisma.user.update({
    where: { id: user.id },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}
```

- [ ] **Step 7: Create `apps/api/src/stripe/sync-sub.ts`**

```ts
import type Stripe from "stripe";
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { stripeClient } from "./client.js";
import { tierForPriceId } from "./pricing-map.js";

/** Re-fetch a subscription from Stripe and UPSERT the local row.
 *
 * Used by every subscription-touching event handler (checkout.session.
 * completed, customer.subscription.created/updated/deleted) and by
 * /billing/sync. Re-fetching is Stripe's documented best practice —
 * webhook delivery is NOT ordered, so the event payload may be stale
 * relative to current Stripe state. Reading from the API guarantees
 * we converge to the correct state regardless of arrival order.
 *
 * Returns the upserted local row, or null if the price is unknown
 * (env mismatch — handler logs + returns 200 to avoid retry storms). */
export async function syncSubscriptionFromStripe(
  env: Env,
  subscriptionId: string,
  userId: string,
): Promise<{ status: string; tier: string } | null> {
  const stripe = stripeClient(env);
  const sub = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["items.data.price"],
  });
  const priceId = sub.items.data[0]?.price.id;
  if (!priceId) {
    console.error(`stripe sub ${sub.id} has no price`);
    return null;
  }
  const tier = tierForPriceId(env, priceId);
  if (!tier) {
    console.error(`stripe sub ${sub.id} has unknown price ${priceId}`);
    return null;
  }
  const upserted = await prisma.subscription.upsert({
    where: {
      source_sourceSubscriptionId: {
        source: "stripe",
        sourceSubscriptionId: sub.id,
      },
    },
    create: {
      userId,
      tier,
      source: "stripe",
      sourceSubscriptionId: sub.id,
      sourceCustomerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      status: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      billingPeriod: "monthly",
    },
    update: {
      tier,
      status: sub.status,
      currentPeriodEnd: new Date(sub.current_period_end * 1000),
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      // Don't change userId on update — sub belongs to one user forever.
    },
  });
  return { status: upserted.status, tier: upserted.tier };
}
```

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json`
Expected: no errors. If there are pre-existing errors in unrelated files (e.g. `chat/turn.ts`), confirm they were there on main; otherwise fix.

- [ ] **Step 9: Commit**

```bash
git add apps/api/package.json apps/api/src/env.ts apps/api/src/stripe/ apps/api/tests/
git commit -m "feat(api): Stripe SDK, env vars, client + helpers

- env.ts: 4 new required STRIPE_* vars + bumped test env literals.
- stripe/client.ts: lazy Stripe singleton mirroring plaid/client.ts,
  cached by secret so test resets don't reuse stale clients.
- stripe/pricing-map.ts: priceIdForTier (env → priceId) and
  tierForPriceId (Stripe priceId → 'lite' | 'pro' | null). Inverse
  helpers both routes and webhooks share.
- stripe/ensure-customer.ts: lazy Customer create + persist before
  Checkout, idempotency-keyed so a DB-write failure between
  customers.create and User.update doesn't orphan a Stripe Customer
  (the retry returns the same record).
- stripe/sync-sub.ts: syncSubscriptionFromStripe(subId, userId)
  re-fetches from Stripe and upserts the local row. Used by every
  subscription event handler + /billing/sync — Stripe's documented
  best practice for handling unordered webhook delivery."
```

---

## Task 4: EffectiveTier consults active subs (TDD)

**Files:**
- Test: `apps/api/tests/billing-tier.test.ts`
- Modify: `apps/api/src/auth/tier.ts`

- [ ] **Step 1: Write failing tests in `apps/api/tests/billing-tier.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { computeEffectiveTier, effectiveTier } from "../src/auth/tier.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("EffectiveTier with subscriptions", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  async function createUser(opts: { trialEndsAt?: Date | null } = {}) {
    return prisma.user.create({
      data: {
        email: `u${Date.now()}-${Math.random()}@example.com`,
        emailVerified: true,
        trialEndsAt: opts.trialEndsAt ?? null,
      },
    });
  }

  async function createSub(userId: string, opts: {
    tier: "lite" | "pro";
    status: "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "incomplete";
    cancelAtPeriodEnd?: boolean;
  }) {
    return prisma.subscription.create({
      data: {
        userId,
        tier: opts.tier,
        source: "stripe",
        sourceSubscriptionId: `sub_${Math.random()}`,
        status: opts.status as any,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? false,
      },
    });
  }

  it("returns free when no trial and no subscription", async () => {
    const user = await createUser();
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("free");
    expect(t.source).toBe("default");
  });

  it("returns pro+trial when trial is active (no sub)", async () => {
    const user = await createUser({ trialEndsAt: new Date(Date.now() + 10 * 86400_000) });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");
    expect(t.source).toBe("trial");
    expect(t.trialActive).toBe(true);
  });

  it("trial wins over paid sub when both active", async () => {
    const user = await createUser({ trialEndsAt: new Date(Date.now() + 10 * 86400_000) });
    await createSub(user.id, { tier: "lite", status: "active" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");        // not lite
    expect(t.source).toBe("trial");
  });

  it("returns lite+paid for active lite sub (no trial)", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "lite", status: "active" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("lite");
    expect(t.source).toBe("paid");
  });

  it("returns pro+paid for active pro sub (no trial)", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "pro", status: "active" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");
    expect(t.source).toBe("paid");
  });

  it("trialing status counts as active", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "pro", status: "trialing" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");
    expect(t.source).toBe("paid");
  });

  it("past_due status keeps user paid (Smart Retries grace)", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "pro", status: "past_due" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");
    expect(t.source).toBe("paid");
  });

  it("canceled status drops user to free", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "pro", status: "canceled" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("free");
    expect(t.source).toBe("default");
  });

  it("incomplete status does not grant paid tier", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "pro", status: "incomplete" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("free");
  });

  it("unpaid status does not grant paid tier", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "pro", status: "unpaid" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("free");
  });

  it("cancelAtPeriodEnd=true keeps user paid until period ends", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "pro", status: "active", cancelAtPeriodEnd: true });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");
    expect(t.source).toBe("paid");
  });

  it("highest tier wins among multiple active subs", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "lite", status: "active" });
    await createSub(user.id, { tier: "pro", status: "active" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-tier.test.ts`
Expected: all 12 tests FAIL — current `computeEffectiveTier` doesn't look at subs.

- [ ] **Step 3: Update `apps/api/src/auth/tier.ts`**

Replace `effectiveTier(userId)` and `computeEffectiveTier(user)`:

```ts
import { TIER_LIMITS, type EffectiveTier, type Tier } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError } from "./context.js";

const ACTIVE_STATUSES: ReadonlyArray<"trialing" | "active" | "past_due"> = [
  "trialing",
  "active",
  "past_due",
];

/** Pure computation when caller already has the User + active subs.
 *  Order of precedence: trial > active paid sub (highest tier) > free. */
export function computeEffectiveTier(
  user: { trialEndsAt: Date | null },
  activeSubs: ReadonlyArray<{ tier: string }> = [],
): EffectiveTier {
  if (user.trialEndsAt && user.trialEndsAt > new Date()) {
    return {
      tier: "pro",
      source: "trial",
      trialActive: true,
      trialEndsAt: user.trialEndsAt,
      plaidItemLimit: TIER_LIMITS.pro.plaidItems,
    };
  }
  // Pick highest tier from active subs.
  const ranked = activeSubs
    .map((s) => s.tier as Tier)
    .filter((t): t is "lite" | "pro" => t === "lite" || t === "pro");
  if (ranked.length > 0) {
    const tier: "lite" | "pro" = ranked.includes("pro") ? "pro" : "lite";
    return {
      tier,
      source: "paid",
      trialActive: false,
      trialEndsAt: user.trialEndsAt,
      plaidItemLimit: TIER_LIMITS[tier].plaidItems,
    };
  }
  return {
    tier: "free",
    source: "default",
    trialActive: false,
    trialEndsAt: user.trialEndsAt,
    plaidItemLimit: TIER_LIMITS.free.plaidItems,
  };
}

export async function effectiveTier(userId: string): Promise<EffectiveTier> {
  const [user, activeSubs] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.subscription.findMany({
      where: { userId, status: { in: ACTIVE_STATUSES as any } },
      select: { tier: true },
    }),
  ]);
  return computeEffectiveTier(user, activeSubs);
}

export async function requireProTier(userId: string): Promise<void> {
  const t = await effectiveTier(userId);
  if (t.tier !== "pro") {
    throw new HttpError(402, "upgrade_required", `Pro tier required (current: ${t.tier})`);
  }
}
```

- [ ] **Step 4: Update existing `/me` caller (apps/api/src/routes/me.ts)**

`computeEffectiveTier(user)` is now `computeEffectiveTier(user, activeSubs)`. Update the route to also fetch active subs and pass them in. Find the existing handler and replace its body — keep the route + cookie behavior:

```ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { computeEffectiveTier } from "../auth/tier.js";
import type { MeDTO, SubscriptionDTO } from "@fina/shared";

const ACTIVE_STATUSES = ["trialing", "active", "past_due"] as const;

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) return reply.code(404).send({ error: "no_user" });
      const activeSubs = await prisma.subscription.findMany({
        where: { userId: user.id, status: { in: ACTIVE_STATUSES as any } },
        orderBy: { currentPeriodEnd: "desc" },
      });
      const t = computeEffectiveTier(user, activeSubs);
      // Highest-tier active sub wins (pro > lite). MeDTO.subscription is
      // null when no active sub — canceled rows are retained in DB but
      // excluded here so the UI never accidentally shows Manage for a
      // dead subscription (codex R8).
      const primary = activeSubs.find((s) => s.tier === "pro") ?? activeSubs[0];
      const subscription: SubscriptionDTO | null = primary
        ? {
            tier: primary.tier as "lite" | "pro",
            status: primary.status as SubscriptionDTO["status"],
            currentPeriodEnd: primary.currentPeriodEnd.toISOString(),
            cancelAtPeriodEnd: primary.cancelAtPeriodEnd,
            source: primary.source as SubscriptionDTO["source"],
          }
        : null;
      const body: MeDTO = {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          tz: user.tz,
          locale: user.locale,
        },
        tier: t.tier,
        trial: { active: t.trialActive, endsAt: t.trialEndsAt?.toISOString() ?? null },
        subscription,
      };
      return body;
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 5: Re-run tier tests**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-tier.test.ts`
Expected: all 12 PASS.

- [ ] **Step 6: Re-run /me tests**

Run: `pnpm --filter @fina/api exec vitest run tests/me.test.ts`
Expected: existing /me tests still PASS (they don't assert on subscription field).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/tier.ts apps/api/src/routes/me.ts apps/api/tests/billing-tier.test.ts
git commit -m "feat(api): EffectiveTier consults active subscriptions

- auth/tier.ts: computeEffectiveTier now accepts active subs and
  applies the spec's precedence (trial > active paid > free).
  past_due, trialing, active count as 'active' for tier purposes;
  canceled / unpaid / incomplete / incomplete_expired / paused
  do not. Highest tier wins among multiple active subs.
- routes/me.ts: fetches active subs once, passes to
  computeEffectiveTier, and surfaces a SubscriptionDTO on
  MeDTO.subscription (null when no active sub — canceled rows in
  DB are filtered out so the UI never shows Manage for a dead sub).
- tests/billing-tier.test.ts: 12 cases covering every status →
  tier mapping plus the trial-wins precedence."
```

---

## Task 5: `/billing/checkout` route (TDD)

**Files:**
- Test: `apps/api/tests/billing-checkout.test.ts`
- Create: `apps/api/src/routes/billing.ts` (this task creates the file; later tasks add `/portal` and `/sync`)
- Modify: `apps/api/src/server.ts` (register the route)

- [ ] **Step 1: Stripe mock helper**

Create `apps/api/tests/helpers/stripe-mock.ts`:

```ts
import { vi } from "vitest";

// Hand-rolled mock surface — only the SDK methods our code touches.
// Each test sets up the methods it cares about via `setMock(...)`.
export function makeStripeMock() {
  const customersCreate = vi.fn();
  const sessionsCreate = vi.fn();
  const sessionsRetrieve = vi.fn();
  const subsRetrieve = vi.fn();
  const subsList = vi.fn();
  const portalCreate = vi.fn();
  return {
    fns: { customersCreate, sessionsCreate, sessionsRetrieve, subsRetrieve, subsList, portalCreate },
    asStripe() {
      return {
        customers: { create: customersCreate },
        checkout: { sessions: { create: sessionsCreate, retrieve: sessionsRetrieve } },
        subscriptions: { retrieve: subsRetrieve, list: subsList },
        billingPortal: { sessions: { create: portalCreate } },
        webhooks: undefined, // tests that need signature verification mock this separately
      } as any;
    },
  };
}

/** vi.mock the stripe client module so every code path that calls
 * stripeClient(env) gets the same hand-rolled object. Test files
 * import this and immediately invoke installStripeMock() at top level. */
export function installStripeMock(mock: ReturnType<typeof makeStripeMock>): void {
  vi.mock("../src/stripe/client.js", () => ({
    stripeClient: () => mock.asStripe(),
    _clearStripeClientCache: () => {},
  }));
}
```

- [ ] **Step 2: Write failing tests in `apps/api/tests/billing-checkout.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { makeStripeMock, installStripeMock } from "./helpers/stripe-mock.js";
const stripe = makeStripeMock();
installStripeMock(stripe);

import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3100",
  PLAID_CLIENT_ID: "test",
  PLAID_SECRET: "test",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
};

describe("POST /billing/checkout", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    // Default: customers.create returns a fresh cus_*
    stripe.fns.customersCreate.mockResolvedValue({ id: "cus_new" });
    stripe.fns.sessionsCreate.mockResolvedValue({
      id: "cs_test",
      url: "https://checkout.stripe.com/cs_test",
    });
  });
  afterAll(async () => {
    await disconnect();
  });

  it("creates Customer then Checkout Session for first-time user", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck1@example.com", name: "CK One" });
    // Fresh signup gets a 30-day trial; clear it so we exercise the
    // no-trial branch (separate test covers trial branch).
    await prisma.user.update({ where: { id: user.userId }, data: { trialEndsAt: null } });

    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "pro" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://checkout.stripe.com/cs_test" });
    expect(stripe.fns.customersCreate).toHaveBeenCalledOnce();
    expect(stripe.fns.customersCreate.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: `customer-create-${user.userId}`,
    });
    expect(stripe.fns.sessionsCreate).toHaveBeenCalledOnce();
    const sessionCall = stripe.fns.sessionsCreate.mock.calls[0]?.[0];
    expect(sessionCall.customer).toBe("cus_new"); // NOT customer_email
    expect(sessionCall.customer_email).toBeUndefined();
    expect(sessionCall.client_reference_id).toBe(user.userId);
    expect(sessionCall.line_items[0].price).toBe(env.STRIPE_PRICE_PRO_MONTHLY);
    expect(sessionCall.success_url).toContain("{CHECKOUT_SESSION_ID}");
    // Persisted on User row
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(fresh.stripeCustomerId).toBe("cus_new");
  });

  it("reuses existing stripeCustomerId without recreating", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck2@example.com", name: "CK Two" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { trialEndsAt: null, stripeCustomerId: "cus_existing" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "lite" },
    });

    expect(res.statusCode).toBe(200);
    expect(stripe.fns.customersCreate).not.toHaveBeenCalled();
    const sessionCall = stripe.fns.sessionsCreate.mock.calls[0]?.[0];
    expect(sessionCall.customer).toBe("cus_existing");
    expect(sessionCall.line_items[0].price).toBe(env.STRIPE_PRICE_LITE_MONTHLY);
  });

  it("passes trial_end when trial >48h away", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck3@example.com", name: "CK Three" });
    const trialEnd = new Date(Date.now() + 10 * 86400_000); // 10 days
    await prisma.user.update({ where: { id: user.userId }, data: { trialEndsAt: trialEnd } });

    await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "pro" },
    });

    const sessionCall = stripe.fns.sessionsCreate.mock.calls[0]?.[0];
    expect(sessionCall.subscription_data).toEqual({
      trial_end: Math.floor(trialEnd.getTime() / 1000),
    });
  });

  it("omits trial_end when trial <48h away (Stripe minimum)", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck4@example.com", name: "CK Four" });
    const soon = new Date(Date.now() + 24 * 3600_000); // 24h — under Stripe's 48h floor
    await prisma.user.update({ where: { id: user.userId }, data: { trialEndsAt: soon } });

    await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "pro" },
    });

    const sessionCall = stripe.fns.sessionsCreate.mock.calls[0]?.[0];
    expect(sessionCall.subscription_data).toBeUndefined();
  });

  it("returns 409 already_subscribed when user has active sub", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck5@example.com", name: "CK Five" });
    await prisma.user.update({ where: { id: user.userId }, data: { trialEndsAt: null } });
    await prisma.subscription.create({
      data: {
        userId: user.userId,
        tier: "pro",
        source: "stripe",
        sourceSubscriptionId: "sub_existing",
        status: "active" as any,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "lite" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_subscribed");
    expect(stripe.fns.sessionsCreate).not.toHaveBeenCalled();
  });

  it("returns 400 invalid_body for bad tier", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ck6@example.com", name: "CK Six" });
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { tier: "free" }, // not a paid tier
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("returns 401 for anonymous", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      headers: { "content-type": "application/json" },
      payload: { tier: "pro" },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 3: Run tests to confirm fail**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-checkout.test.ts`
Expected: all FAIL (route not registered yet — 404 on every request).

- [ ] **Step 4: Create `apps/api/src/routes/billing.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { CheckoutBody } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { stripeClient } from "../stripe/client.js";
import { priceIdForTier } from "../stripe/pricing-map.js";
import { ensureStripeCustomer } from "../stripe/ensure-customer.js";

const STRIPE_TRIAL_END_MIN_MS = 48 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ["trialing", "active", "past_due"] as const;

function useTrialEnd(trialEndsAt: Date | null): boolean {
  if (!trialEndsAt) return false;
  return trialEndsAt.getTime() - Date.now() >= STRIPE_TRIAL_END_MIN_MS;
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  app.post("/billing/checkout", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = CheckoutBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body" });
      }
      const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });

      // 409 if any active sub already exists.
      const active = await prisma.subscription.count({
        where: { userId: user.id, status: { in: ACTIVE_STATUSES as any } },
      });
      if (active > 0) {
        return reply.code(409).send({ error: "already_subscribed" });
      }

      // Codex R7: persist Customer BEFORE Checkout so concurrent
      // first-Checkout attempts don't create duplicate Customers.
      const customerId = await ensureStripeCustomer(app.fina.env, user);

      const stripe = stripeClient(app.fina.env);
      const stripeSession = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [
          { price: priceIdForTier(app.fina.env, parsed.data.tier), quantity: 1 },
        ],
        client_reference_id: user.id,
        customer: customerId,
        success_url: `${app.fina.env.WEB_APP_URL}/settings/plan?status=success&sessionId={CHECKOUT_SESSION_ID}`,
        cancel_url: `${app.fina.env.WEB_APP_URL}/settings/plan?status=cancel`,
        allow_promotion_codes: true,
        subscription_data: useTrialEnd(user.trialEndsAt)
          ? { trial_end: Math.floor(user.trialEndsAt!.getTime() / 1000) }
          : undefined,
      });

      return { url: stripeSession.url };
    } catch (e) {
      if (e instanceof HttpError) {
        return reply.code(e.statusCode).send({ error: e.code });
      }
      app.log.error({ err: e }, "checkout_failed");
      return reply.code(500).send({ error: "checkout_failed" });
    }
  });
}
```

- [ ] **Step 5: Register the route in `apps/api/src/server.ts`**

After the existing `await app.register(chatRoutes);` line (or wherever other routes are registered), add:

```ts
  await app.register(billingRoutes);
```

Add the import at the top:

```ts
import { billingRoutes } from "./routes/billing.js";
```

- [ ] **Step 6: Run tests to confirm pass**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-checkout.test.ts`
Expected: all 7 PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/billing.ts apps/api/src/server.ts apps/api/tests/billing-checkout.test.ts apps/api/tests/helpers/stripe-mock.ts
git commit -m "feat(api): POST /billing/checkout

Stripe Checkout Session creation gated on three rules:

- 409 already_subscribed if any active sub (trialing/active/past_due)
  exists — Stripe Portal handles tier changes, not Checkout.
- ensureStripeCustomer runs BEFORE Checkout (codex R7) so concurrent
  first-Checkout attempts share one Stripe Customer record. Idempotency
  key 'customer-create-<userId>' makes the create safe to retry.
- trial_end is set only when remaining trial > 48h (Stripe's minimum);
  closer-to-expiry trials charge immediately (codex R3).

success_url includes {CHECKOUT_SESSION_ID} so /billing/sync can resolve
the session even before stripeCustomerId is persisted (codex R2).

Tests cover: first-time user (Customer created + persisted), reuse
existing customerId, trial_end >48h, trial_end <48h, already_subscribed,
invalid body, unauth."
```

---

## Task 6: `/billing/portal` route (TDD)

**Files:**
- Test: `apps/api/tests/billing-portal.test.ts`
- Modify: `apps/api/src/routes/billing.ts`

- [ ] **Step 1: Write failing tests `apps/api/tests/billing-portal.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { makeStripeMock, installStripeMock } from "./helpers/stripe-mock.js";
const stripe = makeStripeMock();
installStripeMock(stripe);

import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3100",
  PLAID_CLIENT_ID: "test",
  PLAID_SECRET: "test",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
};

describe("POST /billing/portal", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    stripe.fns.portalCreate.mockResolvedValue({
      url: "https://billing.stripe.com/portal_session",
    });
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns 404 portal_failed when user has no stripeCustomerId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "p1@example.com", name: "P One" });
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("portal_failed");
    expect(stripe.fns.portalCreate).not.toHaveBeenCalled();
  });

  it("returns portal url when user has stripeCustomerId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "p2@example.com", name: "P Two" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_p2" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/billing/portal",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ url: "https://billing.stripe.com/portal_session" });
    expect(stripe.fns.portalCreate).toHaveBeenCalledWith({
      customer: "cus_p2",
      return_url: `${env.WEB_APP_URL}/settings/plan`,
    });
  });

  it("returns 401 for anonymous", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "POST", url: "/billing/portal" });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to confirm fail**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-portal.test.ts`
Expected: all FAIL.

- [ ] **Step 3: Add `/billing/portal` handler to `apps/api/src/routes/billing.ts`**

Append inside `billingRoutes` function:

```ts
  app.post("/billing/portal", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
      if (!user.stripeCustomerId) {
        return reply.code(404).send({ error: "portal_failed" });
      }
      const stripe = stripeClient(app.fina.env);
      const portal = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: `${app.fina.env.WEB_APP_URL}/settings/plan`,
      });
      return { url: portal.url };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e }, "portal_failed");
      return reply.code(500).send({ error: "portal_failed" });
    }
  });
```

- [ ] **Step 4: Re-run tests**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-portal.test.ts`
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/billing.ts apps/api/tests/billing-portal.test.ts
git commit -m "feat(api): POST /billing/portal

Returns a Stripe Customer Portal session URL so the user can cancel,
update their card, view invoices, or switch Lite ↔ Pro. Portal is the
single management UI — we don't host any of that ourselves.

404 portal_failed when the user has no stripeCustomerId (they've never
been to Checkout). 401 for anonymous. 500 for any Stripe API failure."
```

---

## Task 7: `/billing/sync` route (TDD)

**Files:**
- Test: `apps/api/tests/billing-sync.test.ts`
- Modify: `apps/api/src/routes/billing.ts`

- [ ] **Step 1: Write failing tests `apps/api/tests/billing-sync.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { makeStripeMock, installStripeMock } from "./helpers/stripe-mock.js";
const stripe = makeStripeMock();
installStripeMock(stripe);

import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3100",
  PLAID_CLIENT_ID: "test",
  PLAID_SECRET: "test",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
};

function fakeStripeSub(opts: {
  id?: string;
  customer?: string;
  priceId?: string;
  status?: string;
  cancelAtPeriodEnd?: boolean;
}) {
  return {
    id: opts.id ?? "sub_test",
    customer: opts.customer ?? "cus_test",
    status: opts.status ?? "active",
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    current_period_end: Math.floor((Date.now() + 30 * 86400_000) / 1000),
    items: { data: [{ price: { id: opts.priceId ?? env.STRIPE_PRICE_PRO_MONTHLY } }] },
  } as any;
}

describe("POST /billing/sync", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("resolves first-Checkout return via sessionId even without stored customerId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "s1@example.com", name: "S One" });
    stripe.fns.sessionsRetrieve.mockResolvedValue({
      id: "cs_xyz",
      customer: "cus_first",
      subscription: "sub_first",
      client_reference_id: user.userId,
    });
    stripe.fns.subsRetrieve.mockResolvedValue(fakeStripeSub({ id: "sub_first", customer: "cus_first" }));

    const res = await app.inject({
      method: "POST",
      url: "/billing/sync",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: { sessionId: "cs_xyz" },
    });

    expect(res.statusCode).toBe(200);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(fresh.stripeCustomerId).toBe("cus_first");
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_first" } },
    });
    expect(sub.tier).toBe("pro");
    expect(sub.status).toBe("active");
    // MeDTO shape in the response
    expect(res.json().subscription).toMatchObject({ tier: "pro", status: "active", source: "stripe" });
  });

  it("rejects sessionId that does not belong to the caller", async () => {
    const app = await buildApp(env);
    const attacker = await signUpAndGetCookie(app, { email: "s2a@example.com", name: "Attacker" });
    const victim = await signUpAndGetCookie(app, { email: "s2v@example.com", name: "Victim" });
    stripe.fns.sessionsRetrieve.mockResolvedValue({
      id: "cs_victim",
      customer: "cus_victim",
      subscription: "sub_victim",
      client_reference_id: victim.userId,
    });

    const res = await app.inject({
      method: "POST",
      url: "/billing/sync",
      headers: { cookie: attacker.cookie, "content-type": "application/json" },
      payload: { sessionId: "cs_victim" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("checkout_failed");
    const stillNoSub = await prisma.subscription.count({ where: { userId: attacker.userId } });
    expect(stillNoSub).toBe(0);
  });

  it("falls back to customer.subscriptions.list when no sessionId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "s3@example.com", name: "S Three" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_s3" },
    });
    stripe.fns.subsList.mockResolvedValue({
      data: [fakeStripeSub({ id: "sub_s3", customer: "cus_s3" })],
    });
    // sync-sub.ts re-retrieves each sub, so subsRetrieve must respond too.
    stripe.fns.subsRetrieve.mockResolvedValue(fakeStripeSub({ id: "sub_s3", customer: "cus_s3" }));

    const res = await app.inject({
      method: "POST",
      url: "/billing/sync",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(stripe.fns.subsList).toHaveBeenCalledWith({
      customer: "cus_s3",
      status: "all",
      limit: 10,
    });
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_s3" } },
    });
    expect(sub.tier).toBe("pro");
  });

  it("no-op for user with neither sessionId nor stripeCustomerId", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "s4@example.com", name: "S Four" });
    const res = await app.inject({
      method: "POST",
      url: "/billing/sync",
      headers: { cookie: user.cookie, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(stripe.fns.sessionsRetrieve).not.toHaveBeenCalled();
    expect(stripe.fns.subsList).not.toHaveBeenCalled();
    expect(res.json().subscription).toBeNull();
  });

  it("returns 401 for anonymous", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "POST", url: "/billing/sync", payload: {} });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to confirm fail**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-sync.test.ts`
Expected: all FAIL.

- [ ] **Step 3: Add `/billing/sync` to `apps/api/src/routes/billing.ts`**

Append inside `billingRoutes`:

```ts
  app.post("/billing/sync", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = SyncBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
      const stripe = stripeClient(app.fina.env);

      // Path A — sessionId provided (Checkout success redirect).
      if (parsed.data.sessionId) {
        const sess = await stripe.checkout.sessions.retrieve(parsed.data.sessionId);
        if (sess.client_reference_id !== user.id) {
          return reply.code(403).send({ error: "checkout_failed" });
        }
        if (sess.customer) {
          await prisma.user.update({
            where: { id: user.id },
            data: { stripeCustomerId: typeof sess.customer === "string" ? sess.customer : sess.customer.id },
          });
        }
        if (sess.subscription) {
          const subId = typeof sess.subscription === "string" ? sess.subscription : sess.subscription.id;
          await syncSubscriptionFromStripe(app.fina.env, subId, user.id);
        }
      }

      // Path B — pull customer's subs list (covers plain refresh + post-A).
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      if (fresh.stripeCustomerId) {
        const subs = await stripe.subscriptions.list({
          customer: fresh.stripeCustomerId,
          status: "all",
          limit: 10,
        });
        for (const sub of subs.data) {
          await syncSubscriptionFromStripe(app.fina.env, sub.id, user.id);
        }
      }

      // Build MeDTO inline (don't re-export /me logic — keep this self-contained).
      return await buildMeBody(user.id);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e }, "sync_failed");
      return reply.code(500).send({ error: "checkout_failed" });
    }
  });
```

Add at the top of `billing.ts`:

```ts
import { CheckoutBody, SyncBody } from "@fina/shared";
import { syncSubscriptionFromStripe } from "../stripe/sync-sub.js";
import type { MeDTO, SubscriptionDTO } from "@fina/shared";
import { computeEffectiveTier } from "../auth/tier.js";

const ACTIVE_STATUSES_LOCAL = ["trialing", "active", "past_due"] as const;

async function buildMeBody(userId: string): Promise<MeDTO> {
  const [user, activeSubs] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.subscription.findMany({
      where: { userId, status: { in: ACTIVE_STATUSES_LOCAL as any } },
      orderBy: { currentPeriodEnd: "desc" },
    }),
  ]);
  const t = computeEffectiveTier(user, activeSubs);
  const primary = activeSubs.find((s) => s.tier === "pro") ?? activeSubs[0];
  const subscription: SubscriptionDTO | null = primary
    ? {
        tier: primary.tier as "lite" | "pro",
        status: primary.status as SubscriptionDTO["status"],
        currentPeriodEnd: primary.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: primary.cancelAtPeriodEnd,
        source: primary.source as SubscriptionDTO["source"],
      }
    : null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      tz: user.tz,
      locale: user.locale,
    },
    tier: t.tier,
    trial: { active: t.trialActive, endsAt: t.trialEndsAt?.toISOString() ?? null },
    subscription,
  };
}
```

(In a future cleanup task, `buildMeBody` could move into a shared helper used by both `/me` and `/billing/sync`. Out of scope for this PR.)

- [ ] **Step 4: Re-run tests**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-sync.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/billing.ts apps/api/tests/billing-sync.test.ts
git commit -m "feat(api): POST /billing/sync

Bridges the Checkout success redirect vs webhook race (codex R2):

- Path A (sessionId from ?sessionId=...): retrieve session, verify
  client_reference_id matches caller (defence in depth), persist
  customerId, upsert subscription via syncSubscriptionFromStripe.
  Works even when User.stripeCustomerId is still null.
- Path B (no sessionId or after A): list customer's subs and upsert
  each. Covers plain page refreshes.

Returns MeDTO so the UI updates without a second round-trip. 403
checkout_failed if a malicious caller passes another user's session
id."
```

---

## Task 8: Webhook — raw body + signature + idempotency (TDD)

**Files:**
- Test: `apps/api/tests/billing-webhook.test.ts` (just signature / idempotency cases for this task)
- Create: `apps/api/src/routes/billing-webhook.ts`
- Modify: `apps/api/src/server.ts` (raw body content-type parser scoped to webhook URL)

- [ ] **Step 1: Write failing tests `apps/api/tests/billing-webhook.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { makeStripeMock, installStripeMock } from "./helpers/stripe-mock.js";
import Stripe from "stripe";
const stripe = makeStripeMock();
installStripeMock(stripe);

import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3100",
  PLAID_CLIENT_ID: "test",
  PLAID_SECRET: "test",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
};

// Real Stripe webhook signing — we use the actual SDK helper so our
// signature verification path is exercised end-to-end.
function signedEvent(payload: Record<string, unknown>): {
  rawBody: string;
  signature: string;
} {
  const raw = JSON.stringify(payload);
  const sig = Stripe.webhooks.generateTestHeaderString({
    payload: raw,
    secret: env.STRIPE_WEBHOOK_SECRET,
  });
  return { rawBody: raw, signature: sig };
}

describe("POST /webhooks/stripe — signature + idempotency", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("400 webhook_invalid_signature when signature header missing or bad", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ id: "evt_x", type: "ping" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("webhook_invalid_signature");
  });

  it("200 OK for unknown event type (no-op)", async () => {
    const app = await buildApp(env);
    const { rawBody, signature } = signedEvent({
      id: "evt_unknown",
      type: "ping",
      data: { object: {} },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    const stored = await prisma.webhookEvent.count();
    expect(stored).toBe(1); // dedupe row still recorded
  });

  it("same event id delivered twice is no-op (idempotent)", async () => {
    const app = await buildApp(env);
    const { rawBody, signature } = signedEvent({
      id: "evt_dup",
      type: "ping",
      data: { object: {} },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    const second = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    expect(second.statusCode).toBe(200);
    const stored = await prisma.webhookEvent.count({ where: { id: "evt_dup" } });
    expect(stored).toBe(1);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-webhook.test.ts`
Expected: all FAIL.

- [ ] **Step 3: Update `apps/api/src/server.ts` for raw body**

Find `buildApp` and add (BEFORE any route registration but after `const app = Fastify(...)`):

```ts
  // Stripe webhook needs the raw request bytes for signature
  // verification. Add a content-type parser that exposes a raw
  // Buffer on req.body for /webhooks/stripe ONLY; all other routes
  // keep default JSON parsing.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    if (req.url === "/webhooks/stripe") {
      done(null, body);
      return;
    }
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch (e) {
      done(e as Error, undefined);
    }
  });
```

- [ ] **Step 4: Create `apps/api/src/routes/billing-webhook.ts`**

```ts
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { prisma } from "../db.js";

export async function billingWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/stripe", async (req, reply) => {
    const sig = req.headers["stripe-signature"];
    const rawBody = req.body as Buffer | undefined;
    if (!sig || typeof sig !== "string" || !rawBody) {
      return reply.code(400).send({ error: "webhook_invalid_signature" });
    }

    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(
        rawBody,
        sig,
        app.fina.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (e) {
      app.log.warn({ err: e }, "webhook signature verification failed");
      return reply.code(400).send({ error: "webhook_invalid_signature" });
    }

    // Idempotency: if we've already processed this event.id, short-circuit.
    const existing = await prisma.webhookEvent.findUnique({ where: { id: event.id } });
    if (existing) {
      return { ok: true };
    }

    // Dispatch (handlers live below — added in next task).
    // For now: just record the event so the idempotency test passes.
    await prisma.$transaction(async (tx) => {
      // dispatchEvent(tx, event); // added in Task 9
      await tx.webhookEvent.create({
        data: { id: event.id, source: "stripe", type: event.type },
      });
    });

    return { ok: true };
  });
}
```

- [ ] **Step 5: Register webhook route in `apps/api/src/server.ts`**

After `await app.register(billingRoutes);` add:

```ts
  await app.register(billingWebhookRoutes);
```

With matching import:

```ts
import { billingWebhookRoutes } from "./routes/billing-webhook.js";
```

- [ ] **Step 6: Re-run tests**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-webhook.test.ts`
Expected: 3 PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/billing-webhook.ts apps/api/src/server.ts apps/api/tests/billing-webhook.test.ts
git commit -m "feat(api): POST /webhooks/stripe — signature + idempotency

Raw-body content-type parser scoped to /webhooks/stripe so Stripe.
webhooks.constructEvent can verify the signature byte-for-byte. All
other routes keep JSON parsing.

Idempotency via WebhookEvent table keyed on event.id: second delivery
of the same event short-circuits to 200 without re-processing. Event
row written inside a transaction with the handler mutations (handlers
land in the next task) so partial writes can't leave us 'processed
but not deduped' or vice versa.

This task lays the foundation; subscription event dispatch lands next."
```

---

## Task 9: Webhook event dispatch (TDD)

**Files:**
- Modify: `apps/api/tests/billing-webhook.test.ts` (add event-handler cases)
- Modify: `apps/api/src/routes/billing-webhook.ts`

- [ ] **Step 1: Append failing tests to `apps/api/tests/billing-webhook.test.ts`**

```ts
import { signUpAndGetCookie } from "./helpers/auth.js";

function fakeStripeSub(opts: {
  id?: string; customer?: string; priceId?: string; status?: string; cancelAtPeriodEnd?: boolean;
}) {
  return {
    id: opts.id ?? "sub_w",
    customer: opts.customer ?? "cus_w",
    status: opts.status ?? "active",
    cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
    current_period_end: Math.floor((Date.now() + 30 * 86400_000) / 1000),
    items: { data: [{ price: { id: opts.priceId ?? env.STRIPE_PRICE_PRO_MONTHLY } }] },
  } as any;
}

describe("POST /webhooks/stripe — event dispatch", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
  });

  it("checkout.session.completed → sub upserted, customerId set", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w1@example.com", name: "W One" });
    stripe.fns.subsRetrieve.mockResolvedValue(fakeStripeSub({ id: "sub_w1", customer: "cus_w1" }));

    const { rawBody, signature } = signedEvent({
      id: "evt_w1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_w1",
          customer: "cus_w1",
          subscription: "sub_w1",
          client_reference_id: user.userId,
        },
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(fresh.stripeCustomerId).toBe("cus_w1");
    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_w1" } },
    });
    expect(sub.tier).toBe("pro");
    expect(sub.status).toBe("active");
  });

  it("subscription.updated before any .created still creates the row", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w2@example.com", name: "W Two" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_w2" },
    });
    stripe.fns.subsRetrieve.mockResolvedValue(fakeStripeSub({ id: "sub_w2", customer: "cus_w2" }));

    const { rawBody, signature } = signedEvent({
      id: "evt_w2",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_w2", customer: "cus_w2" } },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });

    const sub = await prisma.subscription.findUnique({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_w2" } },
    });
    expect(sub).not.toBeNull();
  });

  it("stale subscription.created retry after newer .updated keeps latest state", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w3@example.com", name: "W Three" });
    await prisma.user.update({
      where: { id: user.userId },
      data: { stripeCustomerId: "cus_w3" },
    });
    // Stripe API returns CURRENT state — we set it to cancelAtPeriodEnd
    // (the newer state). The replayed .created event's payload says
    // active+not-canceling, but our handler re-fetches anyway.
    stripe.fns.subsRetrieve.mockResolvedValue(
      fakeStripeSub({ id: "sub_w3", customer: "cus_w3", cancelAtPeriodEnd: true }),
    );

    const { rawBody, signature } = signedEvent({
      id: "evt_w3_stale",
      type: "customer.subscription.created",
      data: { object: { id: "sub_w3", customer: "cus_w3" } },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });

    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_w3" } },
    });
    expect(sub.cancelAtPeriodEnd).toBe(true);
  });

  it("subscription.deleted → row status=canceled", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w4@example.com", name: "W Four" });
    await prisma.user.update({ where: { id: user.userId }, data: { stripeCustomerId: "cus_w4" } });
    await prisma.subscription.create({
      data: {
        userId: user.userId, tier: "pro", source: "stripe",
        sourceSubscriptionId: "sub_w4", status: "active" as any,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      },
    });
    stripe.fns.subsRetrieve.mockResolvedValue(
      fakeStripeSub({ id: "sub_w4", customer: "cus_w4", status: "canceled" }),
    );

    const { rawBody, signature } = signedEvent({
      id: "evt_w4",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_w4", customer: "cus_w4" } },
    });
    await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });

    const sub = await prisma.subscription.findUniqueOrThrow({
      where: { source_sourceSubscriptionId: { source: "stripe", sourceSubscriptionId: "sub_w4" } },
    });
    expect(sub.status).toBe("canceled");
  });

  it("unknown price ID → 200, no row created, error logged", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "w5@example.com", name: "W Five" });
    await prisma.user.update({ where: { id: user.userId }, data: { stripeCustomerId: "cus_w5" } });
    stripe.fns.subsRetrieve.mockResolvedValue(
      fakeStripeSub({ id: "sub_w5", customer: "cus_w5", priceId: "price_unknown" }),
    );

    const { rawBody, signature } = signedEvent({
      id: "evt_w5",
      type: "customer.subscription.created",
      data: { object: { id: "sub_w5", customer: "cus_w5" } },
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
    const stored = await prisma.subscription.count();
    expect(stored).toBe(0);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-webhook.test.ts`
Expected: the 5 new cases FAIL.

- [ ] **Step 3: Implement dispatch in `apps/api/src/routes/billing-webhook.ts`**

Replace the placeholder with actual dispatch. Whole-file replacement:

```ts
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { prisma } from "../db.js";
import { syncSubscriptionFromStripe } from "../stripe/sync-sub.js";

export async function billingWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post("/webhooks/stripe", async (req, reply) => {
    const sig = req.headers["stripe-signature"];
    const rawBody = req.body as Buffer | undefined;
    if (!sig || typeof sig !== "string" || !rawBody) {
      return reply.code(400).send({ error: "webhook_invalid_signature" });
    }

    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(rawBody, sig, app.fina.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
      app.log.warn({ err: e }, "webhook signature verification failed");
      return reply.code(400).send({ error: "webhook_invalid_signature" });
    }

    // Idempotency — short-circuit on duplicate event id.
    const existing = await prisma.webhookEvent.findUnique({ where: { id: event.id } });
    if (existing) return { ok: true };

    // Dispatch + record in one transaction. Either both commit, or neither.
    try {
      await prisma.$transaction(async (tx) => {
        await handleEvent(app, event);
        await tx.webhookEvent.create({
          data: { id: event.id, source: "stripe", type: event.type },
        });
      });
    } catch (e) {
      app.log.error({ err: e, eventId: event.id, type: event.type }, "webhook handler failed");
      // Return 500 so Stripe retries; idempotency keeps it safe.
      return reply.code(500).send({ error: "webhook_handler_failed" });
    }

    return { ok: true };
  });
}

async function resolveUserIdByCustomer(customerId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { stripeCustomerId: customerId } });
  return user?.id ?? null;
}

async function handleEvent(app: FastifyInstance, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const sess = event.data.object as Stripe.Checkout.Session;
      const userId = sess.client_reference_id;
      if (!userId) {
        app.log.warn({ eventId: event.id }, "checkout.session.completed without client_reference_id");
        return;
      }
      if (sess.customer) {
        const customerId = typeof sess.customer === "string" ? sess.customer : sess.customer.id;
        await prisma.user.updateMany({
          where: { id: userId, OR: [{ stripeCustomerId: null }, { stripeCustomerId: customerId }] },
          data: { stripeCustomerId: customerId },
        });
      }
      if (sess.subscription) {
        const subId = typeof sess.subscription === "string" ? sess.subscription : sess.subscription.id;
        await syncSubscriptionFromStripe(app.fina.env, subId, userId);
      }
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const userId = await resolveUserIdByCustomer(customerId);
      if (!userId) {
        // Customer not yet linked — usually a race with checkout.session.
        // completed; we'll catch up when that event lands and re-sync.
        app.log.info({ eventId: event.id, customerId }, "no local user for customer; skipping");
        return;
      }
      await syncSubscriptionFromStripe(app.fina.env, sub.id, userId);
      return;
    }
    case "invoice.payment_failed":
      // No-op — the subsequent customer.subscription.updated with
      // status=past_due carries the new state.
      return;
    default:
      app.log.debug({ type: event.type }, "ignoring unhandled stripe event");
      return;
  }
}
```

- [ ] **Step 4: Re-run all webhook tests**

Run: `pnpm --filter @fina/api exec vitest run tests/billing-webhook.test.ts`
Expected: all 8 PASS (3 from Task 8 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/billing-webhook.ts apps/api/tests/billing-webhook.test.ts
git commit -m "feat(api): Stripe webhook event dispatch (order-independent)

Every subscription-touching handler re-fetches via syncSubscription
FromStripe and UPSERTs (codex R5). Event payload identifies WHICH
subscription changed; current state always comes from the Stripe API.
That makes the handler convergent regardless of webhook delivery
order:

- checkout.session.completed: persist customerId on User, sync sub.
- customer.subscription.{created,updated,deleted}: resolve user via
  stripeCustomerId, sync sub. Status flips to canceled when Stripe
  has marked the sub as such; row retained for history.
- invoice.payment_failed: no-op (the resulting subscription.updated
  with status=past_due carries the new state).
- unknown event types: log + 200 OK + record dedupe row.

Handler + WebhookEvent row write happen in one transaction; a
partial write returns 500 and Stripe retries (idempotency keeps it
safe). Unknown price IDs log + write nothing but still record the
event so Stripe doesn't retry forever."
```

---

## Task 10: Web — `/settings/plan` rewrite

**Files:**
- Modify: `apps/web/src/app/(app)/settings/plan/page.tsx`

- [ ] **Step 1: Read the existing file**

Run: `cat apps/web/src/app/\(app\)/settings/plan/page.tsx` to see current structure (mock alert stubs, comparison table). The rewrite below replaces ALL alert() stubs with real `apiFetch` calls and adds the success-redirect handling.

- [ ] **Step 2: Replace file contents**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PRICING,
  TIER_LIMITS,
  trialDaysLeft,
  type MeDTO,
  type SubscriptionDTO,
  type PaidTier,
} from "@fina/shared";
import { apiFetch } from "../../../../lib/api";
import styles from "../settings.module.css";

export default function PlanPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "checkout-lite" | "checkout-pro" | "portal">(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await apiFetch<MeDTO>("/me"));
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    const sessionId = params.get("sessionId") ?? undefined;
    if (status === "success") {
      // POST /billing/sync first (codex R2), then strip query, then refresh.
      (async () => {
        try {
          const m = await apiFetch<MeDTO>("/billing/sync", {
            method: "POST",
            body: JSON.stringify({ sessionId }),
          });
          setMe(m);
        } catch (e) {
          setErr((e as { code?: string }).code ?? "sync_error");
        }
        router.replace("/settings/plan");
      })();
    } else {
      refresh();
    }
  }, [refresh, router]);

  if (err) {
    return (
      <div className={styles.container}>
        <p style={{ color: "var(--color-down)" }}>Could not load plan: {err}</p>
      </div>
    );
  }
  if (!me) return <div className={styles.container}>Loading…</div>;

  const onUpgrade = async (tier: PaidTier) => {
    setBusy(tier === "lite" ? "checkout-lite" : "checkout-pro");
    try {
      const { url } = await apiFetch<{ url: string }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ tier }),
      });
      window.location.href = url;
    } catch (e) {
      setErr((e as { code?: string }).code ?? "checkout_failed");
      setBusy(null);
    }
  };

  const onManage = async () => {
    setBusy("portal");
    try {
      const { url } = await apiFetch<{ url: string }>("/billing/portal", { method: "POST" });
      window.location.href = url;
    } catch (e) {
      setErr((e as { code?: string }).code ?? "portal_failed");
      setBusy(null);
    }
  };

  const trialActive = me.trial.active;
  const days = trialDaysLeft(me.trial.endsAt);
  const sub: SubscriptionDTO | null = me.subscription;
  const renderCurrentCard = () => {
    // Decision matrix from spec §"MeDTO extension" → "UI decision matrix".
    if (trialActive && !sub) {
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>Pro trial</div>
            <div className={styles.planCurrentStatus}>
              {days != null ? `${days} day${days === 1 ? "" : "s"} left` : ""}
              {" · Add a card to keep Pro after your trial ends."}
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => onUpgrade("pro")}
              disabled={busy !== null}
            >
              {busy === "checkout-pro" ? "Opening…" : "Add card · Stay on Pro"}
            </button>
          </div>
        </div>
      );
    }
    if (trialActive && sub) {
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>Pro trial</div>
            <div className={styles.planCurrentStatus}>
              {days != null ? `${days} day${days === 1 ? "" : "s"} left.` : ""}{" "}
              {PRICING[sub.tier].displayPrice} charged on{" "}
              {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={onManage}
              disabled={busy !== null}
            >
              {busy === "portal" ? "Opening…" : "Manage subscription"}
            </button>
          </div>
        </div>
      );
    }
    if (sub && sub.status === "past_due") {
      return (
        <div className={styles.planCurrent} style={{ borderColor: "var(--color-down)" }}>
          <div>
            <div className={styles.planCurrentLabel} style={{ color: "var(--color-down)" }}>
              Payment failed
            </div>
            <div className={styles.planCurrentName}>{sub.tier === "pro" ? "Pro" : "Lite"}</div>
            <div className={styles.planCurrentStatus}>
              Update your card to keep your subscription active.
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={onManage}
              disabled={busy !== null}
            >
              Update card
            </button>
          </div>
        </div>
      );
    }
    if (sub && sub.cancelAtPeriodEnd) {
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>{sub.tier === "pro" ? "Pro" : "Lite"}</div>
            <div className={styles.planCurrentStatus}>
              Ends on {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={onManage}
              disabled={busy !== null}
            >
              Resume
            </button>
          </div>
        </div>
      );
    }
    if (sub) {
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>{sub.tier === "pro" ? "Pro" : "Lite"}</div>
            <div className={styles.planCurrentStatus}>
              Renews on {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={onManage}
              disabled={busy !== null}
            >
              Manage subscription
            </button>
          </div>
        </div>
      );
    }
    // No trial, no sub → free
    return (
      <div className={styles.planCurrent}>
        <div>
          <div className={styles.planCurrentLabel}>Current plan</div>
          <div className={styles.planCurrentName}>Free</div>
          <div className={styles.planCurrentStatus}>
            Upgrade to reconnect a bank with automatic syncing.
          </div>
        </div>
      </div>
    );
  };

  const renderUpgradeButton = (tier: PaidTier) => {
    const isCurrent = sub?.tier === tier && !sub?.cancelAtPeriodEnd;
    if (isCurrent) {
      return (
        <button type="button" className={`${styles.btn} ${styles.btnOutline}`} disabled>
          Current plan
        </button>
      );
    }
    return (
      <button
        type="button"
        className={`${styles.btn} ${styles.btnPrimary}`}
        onClick={() => onUpgrade(tier)}
        disabled={busy !== null}
      >
        {busy === (tier === "lite" ? "checkout-lite" : "checkout-pro")
          ? "Opening…"
          : `Upgrade to ${tier === "lite" ? "Lite" : "Pro"}`}
      </button>
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <h1 className={styles.title}>Plan & billing</h1>
        <p className={styles.sub}>Manage your Fina subscription.</p>
      </div>

      {renderCurrentCard()}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Compare plans</div>
          </div>
        </div>
        <div className={styles.card}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 12 }}></th>
                <th style={{ textAlign: "left", padding: 12 }}>Free</th>
                <th style={{ textAlign: "left", padding: 12 }}>
                  Lite · {PRICING.lite.displayPrice} <span style={{ opacity: 0.6 }}>/ mo</span>
                </th>
                <th style={{ textAlign: "left", padding: 12 }}>
                  Pro · {PRICING.pro.displayPrice} <span style={{ opacity: 0.6 }}>/ mo</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderTop: "1px solid var(--color-hairline-soft)" }}>
                <td style={{ padding: 12 }}>Bank connections</td>
                <td style={{ padding: 12 }}>0 (manual / CSV)</td>
                <td style={{ padding: 12 }}>{TIER_LIMITS.lite.plaidItems}</td>
                <td style={{ padding: 12 }}>{TIER_LIMITS.pro.plaidItems}</td>
              </tr>
              <tr style={{ borderTop: "1px solid var(--color-hairline-soft)" }}>
                <td style={{ padding: 12 }}>AI advisor chat</td>
                <td style={{ padding: 12 }}>—</td>
                <td style={{ padding: 12 }}>Read-only ritual</td>
                <td style={{ padding: 12 }}>Full two-way</td>
              </tr>
              <tr style={{ borderTop: "1px solid var(--color-hairline-soft)" }}>
                <td style={{ padding: 12 }}>Workspace sharing</td>
                <td style={{ padding: 12 }}>✓</td>
                <td style={{ padding: 12 }}>✓</td>
                <td style={{ padding: 12 }}>✓</td>
              </tr>
              <tr style={{ borderTop: "1px solid var(--color-hairline-soft)" }}>
                <td style={{ padding: 12 }}></td>
                <td style={{ padding: 12 }}></td>
                <td style={{ padding: 12 }}>{renderUpgradeButton("lite")}</td>
                <td style={{ padding: 12 }}>{renderUpgradeButton("pro")}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p className={styles.sectionSub} style={{ marginTop: 24 }}>
        Subscriptions purchased through the iOS or Android app are managed in
        the App Store / Google Play, not here.
      </p>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck web**

Run: `pnpm --filter @fina/web exec tsc --noEmit`
Expected: no errors. (Pre-existing zod errors in shared schemas are OK if they were there on main.)

- [ ] **Step 4: Build web**

Run: `cd apps/web && pnpm exec next build`
Expected: success.

- [ ] **Step 5: Visual smoke test (manual)**

```bash
# In one terminal — make sure dev API has the new STRIPE_* env vars
pnpm smoke:api
# In another terminal
pnpm smoke:web
```
Navigate to `http://localhost:3100/settings/plan`. Verify:
- Trial active user sees "Pro trial — N days left" with [Add card · Stay on Pro] button.
- Comparison table shows $7 / $15 prices.
- Stripe Checkout opens when clicking Upgrade (will 500 if STRIPE_SECRET_KEY isn't a real test key — that's expected for the smoke without Stripe dashboard set up).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/\(app\)/settings/plan/page.tsx
git commit -m "feat(web): wire /settings/plan to billing routes

Replaces alert() stubs with the real flow:
- ?status=success&sessionId=... → POST /billing/sync (codex R2 bridge),
  then strip the query and refresh MeDTO.
- Upgrade buttons → POST /billing/checkout, redirect to Stripe.
- Manage / Update card / Resume buttons → POST /billing/portal,
  redirect to Stripe Customer Portal.

Current-plan card branches off the spec's UI decision matrix
(trial-only, trial+sub, past_due, cancelAtPeriodEnd, active paid,
free). Past_due gets a red border + Update card CTA. Comparison
table is driven by PRICING and TIER_LIMITS from @fina/shared so a
price change is one edit."
```

---

## Task 11: Docs — `.env.example` + Stripe setup section

**Files:**
- Modify: `apps/api/.env.example`
- Modify: `README.md`

- [ ] **Step 1: Add Stripe block to `apps/api/.env.example`**

Append (or insert near Plaid section):

```
# Stripe (billing — Plan billing-stripe)
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxx
STRIPE_PRICE_LITE_MONTHLY=price_xxxxxxxxxxxxxxxxxxxxxx
STRIPE_PRICE_PRO_MONTHLY=price_xxxxxxxxxxxxxxxxxxxxxx
# WEB_APP_URL above is reused for success/cancel/return URLs.
```

- [ ] **Step 2: Add "Stripe local setup" to `README.md`**

Find an appropriate section (e.g. after the Plaid setup notes) and insert:

```markdown
### Stripe local setup (billing)

1. Sign up at https://dashboard.stripe.com/register (free).
2. In **Developers → API keys**, copy the test-mode Secret key into
   `STRIPE_SECRET_KEY` (sk_test_...).
3. **Products** → New product:
   - "Fina Lite" — recurring $7.00 CAD / month → copy price ID into
     `STRIPE_PRICE_LITE_MONTHLY`.
   - "Fina Pro" — recurring $15.00 CAD / month → copy price ID into
     `STRIPE_PRICE_PRO_MONTHLY`.
4. **Settings → Billing → Customer portal** → Activate. Enable: cancel,
   update card, view invoices, allow switching between Lite and Pro.
5. Forward webhooks locally:
   ```
   stripe listen --forward-to localhost:4000/webhooks/stripe
   ```
   Copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`.
6. Restart API: `pnpm smoke:api`.
7. Visit `http://localhost:3100/settings/plan`, click Upgrade. Use test
   card `4242 4242 4242 4242`, any future expiry, any CVC, any postal.
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/.env.example README.md
git commit -m "docs(billing): .env.example + Stripe local setup section

Walks a fresh contributor through getting Stripe test mode wired up:
sign up, create the two Products, copy Price IDs into env, enable
Customer Portal, run stripe listen, restart API. Test card included."
```

---

## Self-review checklist

After all tasks complete, before opening a PR / merging:

- [ ] `pnpm --filter @fina/api exec vitest run` — full API suite green (including non-billing tests; new STRIPE_* env was added to every test file in Task 3 step 3).
- [ ] `pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json` — no new TS errors (pre-existing chat/turn.ts errors are OK if they were there on main).
- [ ] `pnpm --filter @fina/web exec tsc --noEmit` — web typechecks.
- [ ] `cd apps/web && pnpm exec next build` — production build green.
- [ ] Manual smoke: trial user → Upgrade → Stripe Checkout test card → return → MeDTO reflects subscription → Portal opens.
- [ ] Spec coverage:
  - R1 Stripe status enum (Task 2 enum, Task 4 tier tests cover all 8 statuses).
  - R2 /billing/sync via sessionId (Task 7).
  - R3 trial_end 48h guard (Task 5 step 2 tests + Task 5 step 4 implementation).
  - R4 MeDTO.tier wire shape (Task 4 step 4 — `tier: t.tier` not `tier: t`).
  - R5 Order-independent webhook (Task 9 implementation re-fetches + Task 9 tests verify out-of-order).
  - R6 WEB_APP_URL reuse (Task 5/6 use `app.fina.env.WEB_APP_URL` everywhere, no WEB_BASE_URL).
  - R7 ensureStripeCustomer before Checkout (Task 5 implementation + Task 5 step 2 test).
  - R8 MeDTO.subscription active-only (Task 4 step 4 — filter on ACTIVE_STATUSES_LOCAL).
