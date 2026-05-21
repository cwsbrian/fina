# Billing — Stripe Integration (Lite + Pro)

**Status:** Design  
**Date:** 2026-05-21  
**Branch:** `worktree-billing-stripe`  
**Scope:** Web channel (Stripe). Apple/Google IAP deferred.

## Goal

Turn the `auth/tier.ts:19` placeholder ("Future: check paid subscription column") into a real billing flow so users can pay $7 CAD/month (Lite) or $15 CAD/month (Pro) via Stripe, manage their subscription through Stripe's Customer Portal, and have `EffectiveTier` reflect paid status after their 30-day trial ends.

References this spec builds on:
- `docs/superpowers/specs/2026-05-07-fina-design.md` §13 (pricing model, `subscriptions` table shape, Reader app pattern)
- `docs/superpowers/specs/2026-05-20-fina-web-ui-design.md` §4.4 (`/settings/plan` UI spec)

---

## Shared library touchpoints

### Existing `@fina/shared` exports used

| Export | File | Use |
|---|---|---|
| `Tier`, `TIERS`, `TIER_LIMITS` | `tier.ts` | tier enum + per-tier plaid caps (already wired) |
| `EffectiveTier`, `tierLabel`, `trialDaysLeft` | `tier.ts` | response shape + UI labels |
| `MeDTO` | `dto/me.ts` | `GET /me` response (extended below) |
| `ApiErrorCode`, `isApiError` | `errors.ts` | error code union (extended below) |
| `makeApiFetch` | `http.ts` | unchanged |

### New shared additions

| File | Export | Shape | Motivation |
|---|---|---|---|
| `libs/shared/src/pricing.ts` (new) | `PRICING` | `{ lite: { monthlyCAD: 7, displayPrice: "$7" }, pro: { monthlyCAD: 15, displayPrice: "$15" } } as const` | `/settings/plan` comparison table + any future pricing copy. Stripe Price IDs stay in API env; display prices stay here. |
| `libs/shared/src/dto/subscription.ts` (new) | `SubscriptionDTO`, `SubscriptionStatus`, `SubscriptionSource` | `SubscriptionDTO = { tier: "lite" \| "pro"; status: SubscriptionStatus; currentPeriodEnd: string; cancelAtPeriodEnd: boolean; source: "stripe" }`. Status = `"trialing" \| "active" \| "past_due" \| "canceled" \| "unpaid" \| "incomplete" \| "incomplete_expired" \| "paused"` (mirrors Stripe; only the first three count as active for EffectiveTier). Source = `"stripe" \| "iap_apple" \| "iap_google"` (only `"stripe"` populated in v1). | `/me` response payload + `/settings/plan` rendering |
| `libs/shared/src/dto/me.ts` (modify) | extend `MeDTO` | Add `subscription: SubscriptionDTO \| null` field | UI distinguishes "trial only" vs "trial + card on file" vs "paid, no trial" vs "past_due" |
| `libs/shared/src/errors.ts` (modify) | extend `API_ERROR_CODES` | Add `payment_required`, `checkout_failed`, `portal_failed`, `webhook_invalid_signature`, `already_subscribed` | error codes for the new routes |
| `libs/shared/src/schemas/billing.ts` (new) | `CheckoutBody`, `SyncBody` zod schemas | `CheckoutBody = z.object({ tier: z.enum(["lite", "pro"]) })`. `SyncBody = z.object({ sessionId: z.string().optional() })`. | request body validation for `POST /billing/checkout` and `POST /billing/sync`. `/billing/portal` has no body. |
| `libs/shared/src/tier.ts` (verify, no change) | `EffectiveTier.source` already has `"paid"` | unchanged | keeps EffectiveTier focused on "what tier"; payment details live on `MeDTO.subscription` |

Re-exported from `libs/shared/src/index.ts` so `apps/api` and `apps/web` import via `@fina/shared`.

---

## Architecture

```
                                    Stripe
                                      │
                                      │ webhook
                                      ▼
  apps/web                  apps/api / billing.ts
  /settings/plan                      │
     │ POST /billing/checkout         ├─ POST /billing/checkout  ──► Stripe Checkout Session
     │                                ├─ POST /billing/portal    ──► Stripe Portal Session
     │ POST /billing/portal           ├─ POST /billing/sync      ──► Stripe API → DB
     │                                └─ POST /webhooks/stripe   ◄── Stripe events
     │ POST /billing/sync                          │
     │                                             ▼
     │                              prisma.subscription (upsert)
     │                              prisma.webhookEvent (idempotency)
     ▼
  redirect to Stripe URL
```

Sub data lives in a new `Subscription` table on User (1:N). `EffectiveTier` computation now consults active subscriptions in addition to trial.

---

## Data model (Prisma)

```prisma
// Mirrors every status Stripe can send so the webhook can write the
// value verbatim without enum-validation failures. `unpaid` /
// `incomplete_expired` / `paused` are rare end-states; they all count
// as INACTIVE for EffectiveTier (only `trialing` / `active` /
// `past_due` keep the user on a paid tier — see EffectiveTier rules).
enum SubscriptionStatus {
  trialing
  active
  past_due
  canceled
  unpaid               // final state after Smart Retries exhausted
  incomplete           // first invoice never settled
  incomplete_expired   // Checkout abandoned, auto-canceled by Stripe
  paused               // admin-paused (Stripe dashboard); rare
}

enum SubscriptionSource {
  stripe
  iap_apple   // unused in v1; schema is future-proof per spec §13.7
  iap_google
}

model Subscription {
  id                     String             @id @default(cuid())
  userId                 String
  user                   User               @relation(fields: [userId], references: [id], onDelete: Cascade)

  tier                   String             // "lite" | "pro" — matches @fina/shared Tier
  source                 SubscriptionSource
  sourceSubscriptionId   String             // Stripe "sub_..."
  sourceCustomerId       String?            // Stripe "cus_..."

  status                 SubscriptionStatus
  currentPeriodEnd       DateTime
  cancelAtPeriodEnd      Boolean            @default(false)
  billingPeriod          String             @default("monthly")  // "monthly" | "annual" (annual deferred)

  createdAt              DateTime           @default(now())
  updatedAt              DateTime           @updatedAt

  @@unique([source, sourceSubscriptionId])
  @@index([userId, status])
}

model User {
  // existing fields...
  stripeCustomerId  String?  @unique
  subscriptions     Subscription[]
}

model WebhookEvent {
  id          String   @id              // Stripe event.id ("evt_...")
  source      String                     // "stripe"
  type        String                     // event.type
  receivedAt  DateTime @default(now())

  @@index([source, type])
}
```

Notes:
- `Subscription.tier` is `String` (not Prisma enum) so the value matches the `@fina/shared` `Tier` union exactly without an extra mapping layer. Validated with zod at boundaries.
- `WebhookEvent` stores no payload — only enough to dedupe.
- `User.stripeCustomerId` is unique so a user has at most one Stripe Customer.

---

## EffectiveTier computation (apps/api/src/auth/tier.ts)

Order of precedence, top wins:

```
1. user.trialEndsAt > now
   → { tier: "pro", source: "trial", trialActive: true }

2. active subscriptions where status ∈ {trialing, active, past_due}
   → pick highest tier (pro > lite)
   → { tier: <sub.tier>, source: "paid", trialActive: false }

3. otherwise
   → { tier: "free", source: "default" }
```

**Status-handling decisions:**
- `past_due` keeps tier active. Stripe Smart Retries (default ~28 days, 4 attempts) is in flight; cutting off Pro on first failed charge is hostile. UI surfaces a red "Payment failed — update card" banner.
- `canceled` is immediately inactive. Stripe sets status=`canceled` only when the subscription is fully terminated.
- `cancelAtPeriodEnd = true` does NOT change status — sub stays `active` until `currentPeriodEnd`. UI says "ends on {date}" with a Resume CTA.
- `incomplete` (Checkout completed but first payment never finished — rare with cards) keeps user on `free` until status flips.
- Trial wins over paid sub when both are active: a user who paid mid-trial still sees "Pro trial — N days left" and isn't charged until `trialEndsAt`.

---

## MeDTO extension

```ts
type MeDTO = {
  user: { id, email, name, tz, locale, ... },
  tier: EffectiveTier,                              // existing
  trial: { active: boolean, endsAt: string | null }, // existing
  subscription: SubscriptionDTO | null,              // NEW
};
```

UI decision matrix:

| State | trial.active | subscription | Card to show |
|---|---|---|---|
| Brand-new signup | true | null | "Pro trial — N days left. Add a card to keep Pro after {date}." → [Upgrade to Pro] [Upgrade to Lite] |
| Trial + Stripe sub | true | `{ status: "trialing", ...}` | "Pro trial — N days left. $X charged on {trialEndsAt}." → [Manage] |
| Free post-trial | false | null | "Free plan. Upgrade to reconnect a bank." → [Upgrade ...] |
| Active paid | false | `{ status: "active", ...}` | "Pro — renews on {currentPeriodEnd}." → [Manage] |
| Past due | false | `{ status: "past_due", ...}` | RED banner "Payment failed. Update your card." → [Update card] |
| Cancel scheduled | false | `{ cancelAtPeriodEnd: true, ... }` | "Pro — ends on {currentPeriodEnd}." → [Resume] |
| Canceled | false | `{ status: "canceled", ...}` | "Free plan. Upgrade ..." → [Upgrade ...] |

---

## API routes (apps/api/src/routes/billing.ts)

| Method | Path | Auth | Body | Response | Errors |
|---|---|---|---|---|---|
| POST | `/billing/checkout` | session required | `{ tier: "lite" \| "pro" }` (zod: `CheckoutBody`) | `{ url: string }` | 400 `invalid_body`, 409 `already_subscribed`, 500 `checkout_failed` |
| POST | `/billing/portal` | session required | — | `{ url: string }` | 404 `portal_failed` (no customer yet), 500 `portal_failed` |
| POST | `/billing/sync` | session required | `{ sessionId?: string }` (optional Stripe Checkout Session ID from the success redirect) | `MeDTO` | 500 `checkout_failed` |
| POST | `/webhooks/stripe` | **unauth, Stripe-signed** | raw bytes | `{ ok: true }` | 400 `webhook_invalid_signature` |

### Price ↔ tier helpers (apps/api/src/stripe/pricing-map.ts)

Two small functions both routes/webhook use:

- `priceIdForTier(tier: "lite" | "pro"): string` — reads from env (`STRIPE_PRICE_LITE_MONTHLY`, `STRIPE_PRICE_PRO_MONTHLY`).
- `tierForPriceId(priceId: string): "lite" | "pro" | null` — inverse. Returns `null` for unknown IDs (handled in webhook).

### `/billing/checkout` details

```ts
// pseudocode
const user = await currentUser();
if (await hasActiveSubscription(user.id)) {
  throw new HttpError(409, "already_subscribed");
}
const priceId = priceIdForTier(body.tier);   // env lookup, returns string | null
const session = await stripe.checkout.sessions.create({
  mode: "subscription",
  line_items: [{ price: priceId, quantity: 1 }],
  client_reference_id: user.id,
  customer: user.stripeCustomerId ?? undefined,
  customer_email: user.stripeCustomerId ? undefined : user.email,
  success_url: `${env.WEB_BASE_URL}/settings/plan?status=success&sessionId={CHECKOUT_SESSION_ID}`,
  cancel_url: `${env.WEB_BASE_URL}/settings/plan?status=cancel`,
  allow_promotion_codes: true,
  subscription_data: useTrialEnd(user.trialEndsAt)
    ? { trial_end: Math.floor(user.trialEndsAt!.getTime() / 1000) }
    : undefined,
});
return { url: session.url! };
```

```ts
// Stripe requires trial_end to be at least 48 hours in the future.
// If the user's local trial is closer than that, omit trial_end —
// they'll be charged at Checkout. Documented limitation for users
// who upgrade in their last ~2 days of trial.
const STRIPE_TRIAL_END_MIN_MS = 48 * 60 * 60 * 1000;
function useTrialEnd(trialEndsAt: Date | null): boolean {
  if (!trialEndsAt) return false;
  return trialEndsAt.getTime() - Date.now() >= STRIPE_TRIAL_END_MIN_MS;
}
```

`trial_end` makes Stripe defer the first charge until our trial expires — user gets the rest of their 30 days free even after entering a card. The 48h guard exists because Stripe rejects `trial_end` values closer than that; users upgrading in the final two days of their local trial are charged immediately (acceptable, since they're explicitly choosing to convert and the saved cost is minimal).

### `/billing/portal` details

```ts
const user = await currentUser();
if (!user.stripeCustomerId) {
  throw new HttpError(404, "portal_failed", "No Stripe customer on file");
}
const session = await stripe.billingPortal.sessions.create({
  customer: user.stripeCustomerId,
  return_url: `${env.WEB_BASE_URL}/settings/plan`,
});
return { url: session.url };
```

Stripe Portal config (set in Stripe dashboard) enables: cancel subscription, update payment method, view invoices, switch between Lite ↔ Pro.

### `/billing/sync` details

Bridges the gap between Checkout success redirect and webhook delivery (webhook is usually fast but not guaranteed pre-redirect).

Two code paths because on a user's FIRST Checkout, `stripeCustomerId` is still null until the webhook (or this sync) writes it:

```ts
const user = await currentUser();

// Path A: caller passed the Checkout Session ID from ?sessionId=...
// This works even when stripeCustomerId is still null — fetch the
// session, extract customer + subscription, upsert. Covers the
// "first Checkout, webhook hasn't landed" race.
if (body.sessionId) {
  const sess = await stripe.checkout.sessions.retrieve(body.sessionId, {
    expand: ["subscription", "subscription.items.data.price"],
  });
  // Defence-in-depth: verify the session belongs to this user.
  if (sess.client_reference_id !== user.id) {
    throw new HttpError(403, "checkout_failed", "Session does not belong to caller");
  }
  if (sess.customer) await setStripeCustomerId(user.id, sess.customer as string);
  if (sess.subscription) await upsertSubscription(sess.subscription, user.id);
}

// Path B: no sessionId (e.g. just refreshing /settings/plan). Sync
// the customer's subscriptions list if a customer exists.
const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
if (fresh.stripeCustomerId) {
  const subs = await stripe.subscriptions.list({
    customer: fresh.stripeCustomerId,
    status: "all",
    limit: 10,
  });
  for (const sub of subs.data) {
    await upsertSubscription(sub, user.id);  // same helper webhook uses
  }
}
return await buildMeDTO(user);
```

Idempotent: `@@unique([source, sourceSubscriptionId])` + upsert.

---

## Webhook handler (apps/api/src/routes/billing-webhook.ts)

### Idempotency

```
1. const event = stripe.webhooks.constructEvent(rawBody, sig, env.STRIPE_WEBHOOK_SECRET)
2. const existing = await prisma.webhookEvent.findUnique({ where: { id: event.id } })
   → if found, return { ok: true } immediately
3. prisma.$transaction([
     ...handler(event),
     prisma.webhookEvent.create({ data: { id: event.id, source: "stripe", type: event.type } })
   ])
4. return { ok: true }
```

A second delivery of the same event ID hits step 2 and short-circuits. Within the transaction, handler mutations and the `WebhookEvent` row commit together so a partial write can't leave us "processed but not deduped" or vice versa.

### Event handlers

| event.type | Handler |
|---|---|
| `checkout.session.completed` | Find user by `session.client_reference_id`. Fetch `session.subscription` from Stripe (with `expand: ["items.data.price"]`). Upsert Subscription row. Set `User.stripeCustomerId` if not set. |
| `customer.subscription.created` | Upsert Subscription. Race with checkout.session.completed handled by `@@unique`. |
| `customer.subscription.updated` | Update matching Subscription row: `status`, `currentPeriodEnd`, `cancelAtPeriodEnd`, `tier` (price change). |
| `customer.subscription.deleted` | Update matching Subscription row to `status = canceled`. Row retained for history. |
| `invoice.payment_failed` | No-op (next `subscription.updated` carries `status=past_due`). |
| anything else | No-op (200 OK, structured log). |

### Unknown price IDs

If `tierForPriceId(priceId)` returns `null` during a webhook (deployment env mismatch or a price added in Stripe dashboard but not in env): log error + return 200 OK (don't retry). This prevents Stripe from delivering forever; Slack/Sentry alert surfaces the drift.

### Fastify raw-body for webhook

Stripe signature requires the raw request bytes. Add a content-type parser that exposes raw body on `/webhooks/stripe` only — other routes keep JSON parsing.

```ts
app.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (req, body, done) => {
    if (req.url === "/webhooks/stripe") {
      (req as any).rawBody = body;
      done(null, body);  // body unused for webhook handler
    } else {
      try { done(null, JSON.parse(body.toString("utf8"))); }
      catch (e) { done(e as Error, undefined); }
    }
  },
);
```

(Implementation may use a different mechanism — e.g. a per-route opt-in raw body plugin — as long as the webhook handler sees the raw bytes for signature verification.)

---

## Environment

Add to `apps/api/.env` (and `.env.example`):

```
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
STRIPE_PRICE_LITE_MONTHLY=price_xxx
STRIPE_PRICE_PRO_MONTHLY=price_yyy
WEB_BASE_URL=http://localhost:3100
```

`apps/api/src/env.ts` zod schema gets 5 new required strings.

Local Stripe webhook forwarding for dev: `stripe listen --forward-to localhost:4000/webhooks/stripe`.

---

## Web flow (apps/web/src/app/(app)/settings/plan/page.tsx)

```tsx
useEffect(() => {
  const params = new URLSearchParams(location.search);
  if (params.get("status") === "success") {
    apiFetch("/billing/sync", {
      method: "POST",
      body: JSON.stringify({ sessionId: params.get("sessionId") ?? undefined }),
    })
      .then(() => router.replace("/settings/plan"))
      .then(refreshMe);
  } else {
    fetchMe();
  }
}, []);

async function onUpgrade(tier: "lite" | "pro") {
  const { url } = await apiFetch<{ url: string }>("/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ tier }),
  });
  window.location.href = url;
}

async function onManage() {
  const { url } = await apiFetch<{ url: string }>("/billing/portal", {
    method: "POST",
  });
  window.location.href = url;
}
```

Card variants and comparison table per §4.4 of the web UI spec, driven by the decision matrix above. `PRICING` from `@fina/shared` drives the displayed amounts; `TIER_LIMITS` drives the comparison table's plaid-items row.

---

## Testing (apps/api/tests/billing.test.ts)

Real Postgres, mocked Stripe SDK (`vi.mock("stripe")` returning canned session / subscription objects). Webhook bodies signed with `stripe.webhooks.generateTestHeaderString` so signature verification runs the real path.

Cases:

| Case | Assertion |
|---|---|
| Free user POST /billing/checkout `{ tier: "pro" }` | 200 `{ url }`, Stripe called with correct line_items and `client_reference_id` |
| User with active sub POST /billing/checkout | 409 `already_subscribed` |
| Trial user (>48h left) POST /billing/checkout | Stripe called with `subscription_data.trial_end = Math.floor(trialEndsAt.getTime()/1000)` |
| Trial user (<48h left) POST /billing/checkout | Stripe called WITHOUT `subscription_data.trial_end` (avoids Stripe's 48h-minimum rejection) |
| POST /billing/portal — user without stripeCustomerId | 404 `portal_failed` |
| POST /billing/portal — user with customerId | 200 `{ url }` |
| POST /webhooks/stripe — bad signature | 400 `webhook_invalid_signature`, no DB writes |
| POST /webhooks/stripe — `checkout.session.completed` | Subscription row created, User.stripeCustomerId set, WebhookEvent inserted |
| Same event delivered twice | Second delivery returns 200, no second Subscription row |
| `subscription.updated` with `cancelAtPeriodEnd: true` | Row updated, status still `active`, EffectiveTier still paid |
| `subscription.updated` with `status: past_due` | Row updated, EffectiveTier still paid (Smart Retries safety) |
| `subscription.deleted` | Row `status=canceled`. If trial also expired → EffectiveTier `free`. |
| Webhook with unknown price ID | 200 OK, no row created, error log emitted |
| POST /billing/sync after Checkout success | Subscription row appears, MeDTO.subscription populated |

EffectiveTier unit tests separately cover precedence (trial > paid > free), past_due safety, tier ordering (pro > lite).

---

## Implementation order (commit-by-commit)

Per CLAUDE.md "shared library first" rule:

1. **Shared lib** — `pricing.ts`, `dto/subscription.ts`, `dto/me.ts` (extend), `errors.ts` (extend), `schemas/billing.ts`. One commit. Web + API still compile (no consumers yet).
2. **Prisma** — new `Subscription` model, `WebhookEvent` model, `User.stripeCustomerId` field. Migration script. One commit.
3. **API — env + Stripe client** — `apps/api/src/env.ts`, `apps/api/src/stripe/client.ts` (singleton, like `plaid/client.ts`).
4. **API — billing routes** — `routes/billing.ts` (`/checkout`, `/portal`, `/sync`), wire into app.ts.
5. **API — webhook + tier.ts** — `routes/billing-webhook.ts`, raw-body parser, idempotency helper, update `auth/tier.ts` to consider subscriptions.
6. **API — integration tests** — billing.test.ts, mock Stripe, run.
7. **Web — /settings/plan rewrite** — drive UI from extended MeDTO, wire `/billing/checkout` `/billing/portal` `/billing/sync`, comparison table from PRICING.
8. **Docs / env** — `.env.example`, README dev section ("Stripe local setup"), Stripe dashboard checklist (Products to create, Portal to enable, Webhook endpoint to register).

Each step independently testable. Steps 1–6 ship a working backend even before the UI rewrite (step 7).

---

## Out of scope (explicitly deferred)

- **Apple/Google IAP** — separate PR. Schema (`SubscriptionSource` enum, `subscriptions` table) is future-proof; new sources just add new rows.
- **Annual billing** — v1.5+ per spec §13.11.
- **Multi-currency** — CAD only. Stripe Products live in CAD.
- **Invoice PDF UI** — Stripe Portal serves these.
- **Coupons / promo codes (custom UI)** — `allow_promotion_codes: true` is set on Checkout so dashboard-created promos work without UI changes.
- **Trial extension UI** — local DB workaround (`UPDATE "User" SET trialEndsAt = ...`) is the dev path; no admin UI in this PR.
- **Workspace-scoped billing** — subscriptions stay user-scoped per spec §13.6. Mixed-tier workspaces work as designed.

---

## Open questions resolved during brainstorming

- **Source scope:** Stripe only. IAP scaffolding deferred (schema is future-proof regardless).
- **Tier breadth:** Lite + Pro both ship. Stripe Portal handles up/downgrade.
- **Schema shape:** New `Subscription` table (source-agnostic), not User columns.
- **Trial + Upgrade:** Stripe `trial_end` defers first charge to `trialEndsAt`.
- **Manage UI:** Stripe Customer Portal (no custom cancel/card/invoices UI).

---

## Stripe dashboard setup checklist (for the implementer / operator)

1. Create two Products in Stripe dashboard:
   - "Fina Lite" — recurring $7.00 CAD / month → copy price ID into `STRIPE_PRICE_LITE_MONTHLY`
   - "Fina Pro" — recurring $15.00 CAD / month → copy price ID into `STRIPE_PRICE_PRO_MONTHLY`
2. Settings → Billing → Customer portal → Activate. Enable: cancel subscriptions, update payment method, view invoices, allow switching between Lite and Pro.
3. Developers → Webhooks → Add endpoint:
   - URL (dev): use `stripe listen --forward-to localhost:4000/webhooks/stripe`, copy `whsec_...` into `STRIPE_WEBHOOK_SECRET`.
   - URL (prod): `https://<api-host>/webhooks/stripe`, subscribe to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.
4. Test card for local dev: `4242 4242 4242 4242`, any future expiry, any CVC, any postal.
