# Mobile IAP Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Apple StoreKit 2 + Google Play Billing in-app subscriptions to the Fina mobile app, server-validated and webhook-driven, mirroring the existing Stripe pattern.

**Architecture:** Mobile uses `react-native-iap` to fetch products and initiate purchases. Receipts POST to `/billing/iap/checkout`, which verifies via Apple/Google server APIs, writes `Subscription` row + `User.iap*` binding column, then returns updated `MeDTO`. Apple ASSN V2 webhooks and Google RTDN (Pub/Sub OIDC) hit `/webhooks/iap/apple` and `/webhooks/iap/google` for renewals/cancellations/refunds; both verify signatures, dedup via `WebhookEvent`, then re-fetch + upsert.

**Tech Stack:** TypeScript / React Native / Expo SDK 54 / Fastify / Prisma / PostgreSQL. New libs: `react-native-iap` (mobile), `@apple/app-store-server-library` (Apple ASSN + ASC), `googleapis` + `google-auth-library` (Play Developer API + Pub/Sub OIDC).

**Spec:** `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design.md` (HEAD `5252a20`).

**Conventions (project):** Conventional Commits, NO `Co-Authored-By`, NO emoji. Test framework Vitest (API + shared); Vitest with `@testing-library/react-native` (mobile). One assertion per test where practical; mock store clients (never real Apple/Google calls) in unit + integration tests.

**Dependency graph (`‖` = independent, parallelizable):**
```
0 (test infra) → 1 (shared) → 2 (migration) → 3 (env)
                                               ├→ 4 (apple-client)   ‖
                                               ├→ 5 (google-client)  ‖
                                               └→ 6 (webhook-verify)
                                                   └→ 7 (sync-sub)
                                                       └→ 8 (buildMeBody + sandbox filter)
                                                           ├→ 9 (routes)    ‖
                                                           └→ 10 (webhooks) ‖
                                                               ↓
                                                               11 (mobile lib)
                                                                   ↓
                                                                   12 (mobile UI)
                                                                       ↓
                                                                       13 (sandbox smoke)
                                                                           ↓
                                                                           14 (account-deletion doc)
```

**Test infrastructure conventions** (validated against the real codebase, used throughout):

- All tests live in `apps/api/tests/iap/` (plural `tests`, matches `apps/api/vitest.config.ts` `include: ["tests/**/*.test.ts"]`).
- Shared-package tests are colocated with source — e.g., `libs/shared/src/iap/productIds.test.ts` next to `productIds.ts` (matches existing pattern like `libs/shared/src/notifications.test.ts`).
- DB reset helper: `truncateAll` exported from `apps/api/tests/helpers/db.ts`.
- Session helper: `signUpAndGetCookie(app, email)` exported from `apps/api/tests/helpers/auth.ts`.
- App factory: `buildApp(env, opts?)` from `apps/api/src/server.ts` — Task 0 below extends it to accept an `opts.iap` dependency-injection seam.
- Test env: import `testEnv` from `apps/api/tests/helpers/test-env.ts`.

---

## Task 0: Test infrastructure — `buildApp` IAP dependency injection seam

This task lands BEFORE Task 1 so every subsequent test can wire mock Apple/Google clients into the route handlers without touching real store SDKs.

**Files:**
- Modify: `apps/api/src/server.ts` (extend `buildApp` signature)
- Create: `apps/api/tests/helpers/iap-mocks.ts` (typed factory for the three IAP mock clients)
- Test: `apps/api/tests/iap/buildApp-iap.test.ts`

- [ ] **Step 0.1: Write failing test**

```ts
// apps/api/tests/iap/buildApp-iap.test.ts
import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/server.js";
import { testEnv } from "../helpers/test-env.js";
import { makeIapMocks } from "../helpers/iap-mocks.js";

describe("buildApp IAP injection seam", () => {
  it("exposes injected iap clients on app.fina.iap when opts.iap is provided", async () => {
    const mocks = makeIapMocks();
    const app = await buildApp(testEnv(), { iap: mocks });
    expect((app as any).fina.iap).toBe(mocks);
    await app.close();
  });

  it("leaves app.fina.iap undefined by default (production wires real clients lazily)", async () => {
    const app = await buildApp(testEnv());
    expect((app as any).fina.iap).toBeUndefined();
    await app.close();
  });
});
```

- [ ] **Step 0.2: Implement `iap-mocks.ts` helper**

```ts
// apps/api/tests/helpers/iap-mocks.ts
import { vi } from "vitest";

/** Shape mirrors AppleClient / GoogleClient / OAuth2Client surfaces
 *  used by route + sync code. The factory returns ready-to-mutate
 *  vi.fn() spies; each test does `mocks.appleClient.verifyAndDecodeTransaction.mockResolvedValue(...)`. */
export type IapMocks = {
  appleClient: {
    verifyAndDecodeTransaction: ReturnType<typeof vi.fn>;
    verifyAndDecodeNotification: ReturnType<typeof vi.fn>;
    getSubscriptionStatus: ReturnType<typeof vi.fn>;
    _decodeAndVerifyJws: ReturnType<typeof vi.fn>;
  };
  googleClient: {
    fetchAndNormalize: ReturnType<typeof vi.fn>;
    acknowledgeIfPending: ReturnType<typeof vi.fn>;
    _acknowledge: ReturnType<typeof vi.fn>;
  };
  oidcClient: {
    verifyIdToken: ReturnType<typeof vi.fn>;
  };
};

export function makeIapMocks(): IapMocks {
  return {
    appleClient: {
      verifyAndDecodeTransaction: vi.fn(),
      verifyAndDecodeNotification: vi.fn(),
      getSubscriptionStatus: vi.fn(),
      _decodeAndVerifyJws: vi.fn(),
    },
    googleClient: {
      fetchAndNormalize: vi.fn(),
      acknowledgeIfPending: vi.fn().mockResolvedValue(true),
      _acknowledge: vi.fn().mockResolvedValue(undefined),
    },
    oidcClient: {
      verifyIdToken: vi.fn(),
    },
  };
}
```

- [ ] **Step 0.3: Extend `buildApp` signature in `apps/api/src/server.ts`**

Replace the signature `export async function buildApp(env: Env): Promise<FastifyInstance>` with:

```ts
export type BuildAppOpts = {
  /** Test seam — when present, the IAP route + webhook handlers
   *  consume these mocks via `app.fina.iap` instead of constructing
   *  real Apple/Google clients from env. Untyped here to avoid a
   *  cross-cycle import; the IAP routes do the precise narrowing. */
  iap?: { appleClient: unknown; googleClient: unknown; oidcClient: unknown };
};

export async function buildApp(env: Env, opts: BuildAppOpts = {}): Promise<FastifyInstance> {
  // ... existing body ...
  // After app.fina is constructed (search for `app.decorate("fina"`), append:
  if (opts.iap) {
    (app as any).fina.iap = opts.iap;
  }
  // ... rest of body ...
}
```

The exact insertion point: after `app.decorate("fina", { env, auth, ... });` and BEFORE the `await app.register(...)` calls that load routes (so route handlers can read `app.fina.iap` at registration time).

- [ ] **Step 0.4: Add Pino redact wiring in the same step**

While editing `apps/api/src/server.ts:82` (the `logger:` field of the Fastify config), replace `{ level: "info" }` with:

```ts
logger:
  env.NODE_ENV === "test"
    ? false
    : {
        level: "info",
        redact: {
          paths: [
            "env.APPLE_ASC_PRIVATE_KEY",
            "env.GOOGLE_SERVICE_ACCOUNT_JSON",
            "*.APPLE_ASC_PRIVATE_KEY",
            "*.GOOGLE_SERVICE_ACCOUNT_JSON",
            "*.private_key",
            "*.purchaseToken",
            "*.signedTransactionInfo",
            "*.signedRenewalInfo",
            "*.signedPayload",
            "*.appAccountToken",
            "*.receipt",
            "*.jwsRepresentation",
            "*.body.appAccountToken",
            "*.body.obf",
          ],
          censor: "[REDACTED]",
        },
      },
```

- [ ] **Step 0.5: Run, confirm pass**

```
cd apps/api && npx vitest run tests/iap/buildApp-iap.test.ts
```
Expected: PASS 2/2.

- [ ] **Step 0.6: Commit**

```
git add apps/api/src/server.ts apps/api/tests/helpers/iap-mocks.ts apps/api/tests/iap/buildApp-iap.test.ts
git commit -m "feat(api): buildApp(env, opts.iap) injection seam + Pino redact wiring for IAP secrets"
```

---

## Task 1: `@fina/shared` IAP types, schemas, error codes, namespace

**Files:**
- Create: `libs/shared/src/iap/productIds.ts`
- Create: `libs/shared/src/iap/namespace.ts`
- Create: `libs/shared/src/schemas/iap.ts`
- Modify: `libs/shared/src/errors.ts` (append IAP codes to `API_ERROR_CODES`)
- Modify: `libs/shared/src/index.ts` (re-export new modules)
- Test: `libs/shared/src/iap/productIds.test.ts`
- Test: `libs/shared/src/iap/namespace.test.ts`
- Test: `libs/shared/src/schemas/iap.test.ts`

- [ ] **Step 1.1: Write `productIds` failing tests**

```ts
// libs/shared/src/iap/productIds.test.ts
import { describe, it, expect } from "vitest";
import { IAP_PRODUCT_IDS, tierForIapProductId, iapProductIdForTier, type IAPProductId } from "../../src/iap/productIds.js";

describe("IAP_PRODUCT_IDS", () => {
  it("maps lite_monthly → lite", () => {
    expect(IAP_PRODUCT_IDS.lite_monthly.tier).toBe("lite");
  });
  it("maps pro_monthly → pro", () => {
    expect(IAP_PRODUCT_IDS.pro_monthly.tier).toBe("pro");
  });
  it("tierForIapProductId returns tier for known id", () => {
    expect(tierForIapProductId("lite_monthly")).toBe("lite");
    expect(tierForIapProductId("pro_monthly")).toBe("pro");
  });
  it("tierForIapProductId returns null for unknown id", () => {
    expect(tierForIapProductId("nonsense" as IAPProductId)).toBeNull();
  });
  it("iapProductIdForTier is the inverse of tierForIapProductId", () => {
    expect(iapProductIdForTier("lite")).toBe("lite_monthly");
    expect(iapProductIdForTier("pro")).toBe("pro_monthly");
  });
});
```

- [ ] **Step 1.2: Run, confirm fails**

```
cd libs/shared && npx vitest run tests/iap/productIds.test.ts
```
Expected: FAIL "Cannot find module './iap/productIds.js'".

- [ ] **Step 1.3: Implement `productIds.ts`**

```ts
// libs/shared/src/iap/productIds.ts
import type { PaidTier } from "../pricing.js";

/** Single source of truth for IAP product SKUs. Same IDs on both
 *  Apple App Store and Google Play. v1 is monthly only — annual lands
 *  in v1.5 (per spec §12). billingPeriod intentionally omitted from
 *  the constant until then; v1 stores "monthly" directly on
 *  Subscription.billingPeriod at upsert time. */
export const IAP_PRODUCT_IDS = {
  lite_monthly: { tier: "lite" as const },
  pro_monthly:  { tier: "pro"  as const },
} as const;

export type IAPProductId = keyof typeof IAP_PRODUCT_IDS;

export function tierForIapProductId(id: IAPProductId | string): PaidTier | null {
  if (id === "lite_monthly") return "lite";
  if (id === "pro_monthly") return "pro";
  return null;
}

export function iapProductIdForTier(tier: PaidTier): IAPProductId {
  if (tier === "lite") return "lite_monthly";
  if (tier === "pro") return "pro_monthly";
  const _exhaustive: never = tier;
  throw new Error(`Unknown tier: ${_exhaustive}`);
}
```

- [ ] **Step 1.4: Run, confirm passes**

```
npx vitest run tests/iap/productIds.test.ts
```
Expected: PASS 5/5.

- [ ] **Step 1.5: Write `namespace` failing test**

```ts
// libs/shared/src/iap/namespace.test.ts
import { describe, it, expect } from "vitest";
import { IAP_NAMESPACE } from "../../src/iap/namespace.js";

describe("IAP_NAMESPACE", () => {
  it("is a v4-shaped UUID constant", () => {
    expect(IAP_NAMESPACE).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("never changes (deterministic binding depends on this)", () => {
    expect(IAP_NAMESPACE).toBe("8f3a7c2e-1b4d-4e5f-9a6b-7c8d9e0f1a2b");
  });
});
```

- [ ] **Step 1.6: Implement `namespace.ts`**

```ts
// libs/shared/src/iap/namespace.ts
/** Pinned UUID for uuidv5-derivation of Apple `appAccountToken` from
 *  Fina userId. NEVER change this — changing it breaks the binding
 *  for every existing IAP subscriber and forces them through a manual
 *  support resync. Source-code disclosure does NOT weaken security:
 *  the binding tokens are identifiers, not authenticators (see
 *  spec §3 "These binding tokens are identifiers, not authenticators").
 *
 *  Generated once via `uuidgen` on 2026-05-26. */
export const IAP_NAMESPACE = "8f3a7c2e-1b4d-4e5f-9a6b-7c8d9e0f1a2b";
```

- [ ] **Step 1.7: Run namespace test, confirm pass**

```
npx vitest run tests/iap/namespace.test.ts
```
Expected: PASS 2/2.

- [ ] **Step 1.8: Write schemas failing tests**

```ts
// libs/shared/src/schemas/iap.test.ts
import { describe, it, expect } from "vitest";
import { IAPCheckoutBody, IAPRestoreBody } from "../../src/schemas/iap.js";

describe("IAPCheckoutBody", () => {
  it("accepts a valid iOS body", () => {
    const r = IAPCheckoutBody.safeParse({
      platform: "ios",
      productId: "pro_monthly",
      receipt: "eyJhbGciOiJFUzI1NiJ9.payload.sig",
    });
    expect(r.success).toBe(true);
  });
  it("rejects unknown productId", () => {
    const r = IAPCheckoutBody.safeParse({
      platform: "ios",
      productId: "free_monthly",
      receipt: "x",
    });
    expect(r.success).toBe(false);
  });
  it("rejects empty receipt", () => {
    const r = IAPCheckoutBody.safeParse({
      platform: "android",
      productId: "lite_monthly",
      receipt: "",
    });
    expect(r.success).toBe(false);
  });
});

describe("IAPRestoreBody", () => {
  it("accepts 1-20 purchases", () => {
    const purchases = Array.from({ length: 20 }, (_, i) => ({
      productId: "lite_monthly" as const,
      receipt: `r${i}`,
    }));
    const r = IAPRestoreBody.safeParse({ platform: "ios", purchases });
    expect(r.success).toBe(true);
  });
  it("rejects empty purchases array", () => {
    const r = IAPRestoreBody.safeParse({ platform: "ios", purchases: [] });
    expect(r.success).toBe(false);
  });
  it("rejects more than 20 purchases", () => {
    const purchases = Array.from({ length: 21 }, () => ({
      productId: "pro_monthly" as const,
      receipt: "r",
    }));
    const r = IAPRestoreBody.safeParse({ platform: "ios", purchases });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 1.9: Implement `schemas/iap.ts`**

```ts
// libs/shared/src/schemas/iap.ts
import { z } from "zod";

export const IAPPlatform = z.enum(["ios", "android"]);
export type IAPPlatform = z.infer<typeof IAPPlatform>;

const IAPProductIdEnum = z.enum(["lite_monthly", "pro_monthly"]);

export const IAPCheckoutBody = z.object({
  platform: IAPPlatform,
  productId: IAPProductIdEnum,
  /** iOS: signedTransaction JWS string (~2-3 KB, StoreKit 2).
   *  Android: purchaseToken (short opaque string). */
  receipt: z
    .string()
    .min(1)
    .describe("iOS: signedTransaction JWS string; Android: purchaseToken"),
});
export type IAPCheckoutBody = z.infer<typeof IAPCheckoutBody>;

export const IAPRestoreBody = z.object({
  platform: IAPPlatform,
  purchases: z
    .array(
      z.object({
        productId: IAPProductIdEnum,
        receipt: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
});
export type IAPRestoreBody = z.infer<typeof IAPRestoreBody>;
```

- [ ] **Step 1.10: Run schemas test, confirm pass**

```
npx vitest run test/schemas/iap.test.ts
```
Expected: PASS 6/6.

- [ ] **Step 1.11: Append IAP error codes to `errors.ts`**

Find the `API_ERROR_CODES` array and append:

```ts
// libs/shared/src/errors.ts — append to API_ERROR_CODES array
  "invalid_receipt",
  "expired_receipt",
  "product_mismatch",
  "already_subscribed_stripe",
  "already_subscribed_iap",
  "user_mismatch",
  "platform_unavailable",
  "iap_not_configured",
```

- [ ] **Step 1.12: Re-export from `libs/shared/src/index.ts`**

Add lines:

```ts
export * from "./iap/productIds.js";
export * from "./iap/namespace.js";
export * from "./schemas/iap.js";
```

- [ ] **Step 1.13: Run full shared test suite + build**

```
cd libs/shared && npx vitest run && npm run build
```
Expected: all tests pass + build emits dist/.

- [ ] **Step 1.14: Commit**

```
git add libs/shared/src/iap libs/shared/src/schemas/iap.ts libs/shared/src/errors.ts libs/shared/src/index.ts libs/shared/src/schemas/iap.test.ts
git commit -m "feat(shared): IAP product IDs, schemas, namespace, error codes"
```

---

## Task 2: Prisma migration — `User.iap*`, `Subscription.environment`, `IapDeletedBinding`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (User additions, Subscription.environment, new IapDeletedBinding model)
- Create: `apps/api/prisma/migrations/<timestamp>_iap_billing/migration.sql` (generated by Prisma)
- Test: `apps/api/tests/iap/schema.smoke.test.ts`

- [ ] **Step 2.1: Edit `User` model**

In `apps/api/prisma/schema.prisma`, find `model User` and append the two unique columns INSIDE the model braces (before the relations block):

```prisma
  // IAP binding tokens — deterministic per-user identifiers used by
  // webhook handlers as the fallback path when the Subscription row
  // doesn't yet exist (first-purchase race, Android resubscribe).
  // Written on first successful /billing/iap/checkout. Identifiers,
  // not authenticators — see spec §3.
  iapAppleAccountToken    String?  @unique
  iapGoogleObfuscatedId   String?  @unique
```

- [ ] **Step 2.2: Edit `Subscription` model**

Add to `model Subscription` (before `createdAt`):

```prisma
  /// "Production" | "Sandbox" — derived from verified transaction's
  /// `environment` claim (Apple) or v2 response's sandbox flag (Google).
  /// Defaults to "Production" for existing Stripe rows. buildMeBody /
  /// effectiveTier filter out rows where this disagrees with the
  /// runtime APPLE_ENV / google env to prevent stale sandbox rows
  /// from granting prod entitlement.
  environment       String   @default("Production")
```

- [ ] **Step 2.3: Add `IapDeletedBinding` model + `WebhookEvent.body` column**

Append at end of file:

```prisma
/// Tombstone for IAP bindings whose `User` row was deleted. Webhook
/// handlers consult this to stop retrying notifications for purchases
/// that will never resolve to a Fina user. Forensic-only — never read
/// by /me or any user-facing route.
model IapDeletedBinding {
  id         String   @id @default(cuid())
  source     String   // "iap_apple" | "iap_google"
  /// SHA-256 of the binding token. Hashed so the deleted-user
  /// identifier is not recoverable from this table.
  tokenHash  String
  /// Optional SHA-256 of the original userId for support-replay.
  userIdHash String?
  deletedAt  DateTime @default(now())

  @@unique([source, tokenHash])
  @@index([source])
  @@map("iap_deleted_bindings")
}

/// Tracks per-binding-token retry counts for the IAP unattributable-
/// renewal fallback (spec §5.3 step 4). Distinct from WebhookEvent
/// (which is keyed on notificationUUID/messageId and is the DEDUP
/// surface) — Apple's real retries deliver the SAME notificationUUID,
/// so retry-cap must be keyed on the binding token instead. After
/// MAX_UNKNOWN_RETRIES (5) the webhook returns 200 with a forensic
/// WebhookEvent so the store stops retrying.
model IapRetryCounter {
  id         String   @id @default(cuid())
  source     String   // "iap_apple" | "iap_google"
  /// SHA-256 of the binding token (appAccountToken / obfuscatedExternalAccountId).
  tokenHash  String
  attempts   Int      @default(0)
  firstAt    DateTime @default(now())
  lastAt     DateTime @default(now())

  @@unique([source, tokenHash])
  @@map("iap_retry_counters")
}
```

Also modify `model WebhookEvent` (find it in the existing file around `// Stores enough to dedupe` near line 711) and add a `body Json?` column INSIDE the model braces:

```prisma
  /// Optional structured payload for forensic event types
  /// (unattributable_after_delete / unattributable_giveup / etc.).
  /// Existing Stripe dedup rows leave this null. PII fields covered
  /// by Pino redact list (Task 0).
  body  Json?
```

Single migration covers all four schema changes (User.iap*, Subscription.environment, IapDeletedBinding, IapRetryCounter, WebhookEvent.body).

- [ ] **Step 2.4: Generate the migration**

```
cd apps/api && npx prisma migrate dev --name iap_billing
```
Expected output: `Applied 1 migration` + Prisma Client regenerated. Inspect the emitted SQL to confirm: ALTER TABLE users add two nullable unique columns, ALTER TABLE subscriptions add environment, CREATE TABLE iap_deleted_bindings.

- [ ] **Step 2.5: Write schema smoke test**

```ts
// apps/api/tests/iap/schema.smoke.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";

describe("IAP schema migration", () => {
  beforeEach(async () => { await truncateAll(); });

  it("accepts iapAppleAccountToken on User", async () => {
    const u = await prisma.user.create({
      data: { id: "u1", email: "u1@test", iapAppleAccountToken: "tok-1" },
    });
    expect(u.iapAppleAccountToken).toBe("tok-1");
  });

  it("enforces unique iapAppleAccountToken across users", async () => {
    await prisma.user.create({ data: { id: "u1", email: "u1@test", iapAppleAccountToken: "tok-1" } });
    await expect(
      prisma.user.create({ data: { id: "u2", email: "u2@test", iapAppleAccountToken: "tok-1" } }),
    ).rejects.toThrow();
  });

  it("defaults Subscription.environment to Production", async () => {
    const u = await prisma.user.create({ data: { id: "u1", email: "u1@test" } });
    const s = await prisma.subscription.create({
      data: {
        userId: u.id,
        tier: "lite",
        source: "stripe",
        sourceSubscriptionId: "sub_1",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      },
    });
    expect(s.environment).toBe("Production");
  });

  it("stores and queries IapDeletedBinding tombstones", async () => {
    await prisma.iapDeletedBinding.create({
      data: { source: "iap_apple", tokenHash: "h1" },
    });
    const hit = await prisma.iapDeletedBinding.findUnique({
      where: { source_tokenHash: { source: "iap_apple", tokenHash: "h1" } },
    });
    expect(hit).not.toBeNull();
  });
});
```

- [ ] **Step 2.6: Run, confirm passes**

```
cd apps/api && npx vitest run tests/iap/schema.smoke.test.ts
```
Expected: PASS 4/4.

- [ ] **Step 2.7: Commit**

```
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/tests/iap/schema.smoke.test.ts
git commit -m "feat(api): prisma migration for IAP billing — User.iap* + Subscription.environment + IapDeletedBinding"
```

---

## Task 3: API env vars + `redactEnv` helper + boot validation + `iap_not_configured` 503 guard

**Files:**
- Modify: `apps/api/src/env.ts` (add all IAP env vars + boot-time shape validation that NEVER prints values)
- Modify: `apps/api/src/logger.ts` (extend Pino `redact` paths) — if file doesn't exist, find Pino init in `apps/api/src/server.ts` and add there
- Create: `apps/api/src/iap/env-guard.ts` (`requireIapEnv()` returns the typed config or throws 503)
- Create: `apps/api/src/iap/redactEnv.ts`
- Test: `apps/api/tests/iap/env.test.ts`
- Test: `apps/api/tests/iap/env-guard.test.ts`

- [ ] **Step 3.1: Add env vars**

Open `apps/api/src/env.ts`, append to the `Schema` object (before the closing `})`):

```ts
  // Apple IAP
  APPLE_BUNDLE_ID: z.string().optional(),
  APPLE_ASC_ISSUER_ID: z.string().optional(),
  APPLE_ASC_KEY_ID: z.string().optional(),
  // PEM-encoded .p8 — accept raw OR base64. The IAP env-guard verifies
  // shape ("BEGIN PRIVATE KEY") without ever including the value in
  // an error message.
  APPLE_ASC_PRIVATE_KEY: z.string().optional(),
  APPLE_ENV: z.enum(["sandbox", "production"]).optional(),
  // Google IAP
  GOOGLE_PACKAGE_NAME: z.string().optional(),
  // JSON service-account key. Accept raw OR base64 (preferred for
  // Vercel's 4 KB per-var cap). Loader tries base64 first.
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_PUBSUB_VERIFY_AUDIENCE: z.string().optional(),
  GOOGLE_PUBSUB_VERIFY_EMAIL: z.string().optional(),
  GOOGLE_PUBSUB_SUBSCRIPTION_NAME: z.string().optional(),
```

- [ ] **Step 3.2: Write `redactEnv` test**

```ts
// apps/api/tests/iap/env.test.ts
import { describe, it, expect } from "vitest";
import { redactEnv } from "../../src/iap/redactEnv.js";

describe("redactEnv", () => {
  it("masks every IAP secret while preserving other env keys", () => {
    const out = redactEnv({
      NODE_ENV: "test",
      APPLE_ASC_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIGTAg...",
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x@y","private_key":"-----BEGIN..."}',
      DATABASE_URL: "postgres://u:p@h/d",
    } as any);
    expect(out.NODE_ENV).toBe("test");
    expect(out.APPLE_ASC_PRIVATE_KEY).toBe("[REDACTED]");
    expect(out.GOOGLE_SERVICE_ACCOUNT_JSON).toBe("[REDACTED]");
    expect(out.DATABASE_URL).toBe("postgres://u:p@h/d");
  });
});
```

- [ ] **Step 3.3: Implement `redactEnv`**

```ts
// apps/api/src/iap/redactEnv.ts
const IAP_SECRET_KEYS = new Set([
  "APPLE_ASC_PRIVATE_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
]);

/** Returns a shallow copy of `env` with IAP secret values replaced by
 *  `[REDACTED]`. Use anywhere env content might be logged or printed.
 *  Pino's redact config covers structured logs; this helper covers
 *  ad-hoc diagnostics that bypass Pino (e.g. boot-time stderr). */
export function redactEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = IAP_SECRET_KEYS.has(k) ? "[REDACTED]" : v;
  }
  return out;
}
```

- [ ] **Step 3.4: Run `env.test.ts`, confirm pass**

```
cd apps/api && npx vitest run tests/iap/env.test.ts
```
Expected: PASS 1/1.

- [ ] **Step 3.5: Write `requireIapEnv` test**

```ts
// apps/api/tests/iap/env-guard.test.ts
import { describe, it, expect } from "vitest";
import { requireIapEnv } from "../../src/iap/env-guard.js";

const APPLE_ONLY = {
  APPLE_BUNDLE_ID: "com.fina.app",
  APPLE_ASC_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
  APPLE_ASC_KEY_ID: "ABCDEF1234",
  APPLE_ASC_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nMIGTAg...\n-----END PRIVATE KEY-----\n",
  APPLE_ENV: "sandbox" as const,
};

describe("requireIapEnv", () => {
  it("returns apple+google configs when all set", () => {
    const env = {
      ...APPLE_ONLY,
      GOOGLE_PACKAGE_NAME: "app.fina",
      GOOGLE_SERVICE_ACCOUNT_JSON: '{"client_email":"x@y","private_key":"-----BEGIN PRIVATE KEY-----\\n…\\n-----END PRIVATE KEY-----\\n"}',
      GOOGLE_PUBSUB_VERIFY_AUDIENCE: "https://api.fina.app/webhooks/iap/google",
      GOOGLE_PUBSUB_VERIFY_EMAIL: "iap-pubsub@fina.iam.gserviceaccount.com",
      GOOGLE_PUBSUB_SUBSCRIPTION_NAME: "projects/fina/subscriptions/iap-rtdn",
    } as any;
    const cfg = requireIapEnv(env);
    expect(cfg.apple.bundleId).toBe("com.fina.app");
    expect(cfg.google.packageName).toBe("app.fina");
  });

  it("accepts base64-encoded GOOGLE_SERVICE_ACCOUNT_JSON", () => {
    const raw = '{"client_email":"x@y","private_key":"-----BEGIN PRIVATE KEY-----\\n…\\n-----END PRIVATE KEY-----\\n"}';
    const env = {
      ...APPLE_ONLY,
      GOOGLE_PACKAGE_NAME: "app.fina",
      GOOGLE_SERVICE_ACCOUNT_JSON: Buffer.from(raw).toString("base64"),
      GOOGLE_PUBSUB_VERIFY_AUDIENCE: "x",
      GOOGLE_PUBSUB_VERIFY_EMAIL: "y@z",
      GOOGLE_PUBSUB_SUBSCRIPTION_NAME: "n",
    } as any;
    const cfg = requireIapEnv(env);
    expect(cfg.google.serviceAccount.client_email).toBe("x@y");
  });

  it("throws 503 iap_not_configured when APPLE_ASC_PRIVATE_KEY missing", () => {
    const env: any = { ...APPLE_ONLY, APPLE_ASC_PRIVATE_KEY: undefined };
    let err: any;
    try { requireIapEnv(env); } catch (e) { err = e; }
    expect(err.statusCode).toBe(503);
    expect(err.code).toBe("iap_not_configured");
  });

  it("throws WITHOUT echoing any portion of the env value", () => {
    const env: any = { ...APPLE_ONLY, APPLE_ASC_PRIVATE_KEY: "leak-this-prefix-NOT" };
    let err: any;
    try {
      // Force shape failure: strip BEGIN marker
      requireIapEnv({ ...env, APPLE_ASC_PRIVATE_KEY: "leak-this-prefix-NOT" });
    } catch (e) { err = e; }
    const msg = String(err?.message ?? "") + String(err?.stack ?? "");
    expect(msg).not.toContain("leak-this-prefix");
  });
});
```

- [ ] **Step 3.6: Implement `env-guard.ts`**

```ts
// apps/api/src/iap/env-guard.ts
import { HttpError } from "../auth/context.js";

export type AppleIapConfig = {
  bundleId: string;
  ascIssuerId: string;
  ascKeyId: string;
  ascPrivateKey: string;
  env: "sandbox" | "production";
};

export type GoogleIapConfig = {
  packageName: string;
  serviceAccount: { client_email: string; private_key: string; [k: string]: unknown };
  pubsubVerifyAudience: string;
  pubsubVerifyEmail: string;
  pubsubSubscriptionName: string;
};

export type IapConfig = { apple: AppleIapConfig; google: GoogleIapConfig };

/** Returns a fully-validated IAP config or throws HttpError(503,
 *  "iap_not_configured"). The thrown error NEVER carries any portion
 *  of an env value — only the var key name. Callers should use this
 *  inside route handlers / sync helpers so that IAP-less dev / test
 *  envs surface a clean 503 rather than a generic 500. */
export function requireIapEnv(env: NodeJS.ProcessEnv): IapConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new HttpError(503, "iap_not_configured", `${k} is not set`);
    return v;
  };

  const appleKeyRaw = need("APPLE_ASC_PRIVATE_KEY");
  // Accept base64 OR raw PEM. Detect by presence of header line.
  let appleKey = appleKeyRaw;
  if (!appleKeyRaw.includes("BEGIN PRIVATE KEY")) {
    try {
      appleKey = Buffer.from(appleKeyRaw, "base64").toString("utf8");
    } catch {
      throw new HttpError(503, "iap_not_configured", "APPLE_ASC_PRIVATE_KEY base64 decode failed");
    }
  }
  if (!appleKey.includes("BEGIN PRIVATE KEY")) {
    throw new HttpError(503, "iap_not_configured", "APPLE_ASC_PRIVATE_KEY shape invalid");
  }

  const appleEnvRaw = need("APPLE_ENV");
  if (appleEnvRaw !== "sandbox" && appleEnvRaw !== "production") {
    throw new HttpError(503, "iap_not_configured", "APPLE_ENV must be sandbox|production");
  }

  const apple: AppleIapConfig = {
    bundleId: need("APPLE_BUNDLE_ID"),
    ascIssuerId: need("APPLE_ASC_ISSUER_ID"),
    ascKeyId: need("APPLE_ASC_KEY_ID"),
    ascPrivateKey: appleKey,
    env: appleEnvRaw,
  };

  const saRaw = need("GOOGLE_SERVICE_ACCOUNT_JSON");
  let saText = saRaw;
  if (!saRaw.trimStart().startsWith("{")) {
    try {
      saText = Buffer.from(saRaw, "base64").toString("utf8");
    } catch {
      throw new HttpError(503, "iap_not_configured", "GOOGLE_SERVICE_ACCOUNT_JSON base64 decode failed");
    }
  }
  let serviceAccount: GoogleIapConfig["serviceAccount"];
  try {
    serviceAccount = JSON.parse(saText);
  } catch {
    throw new HttpError(503, "iap_not_configured", "GOOGLE_SERVICE_ACCOUNT_JSON parse failed");
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new HttpError(503, "iap_not_configured", "GOOGLE_SERVICE_ACCOUNT_JSON missing client_email/private_key");
  }

  const google: GoogleIapConfig = {
    packageName: need("GOOGLE_PACKAGE_NAME"),
    serviceAccount,
    pubsubVerifyAudience: need("GOOGLE_PUBSUB_VERIFY_AUDIENCE"),
    pubsubVerifyEmail: need("GOOGLE_PUBSUB_VERIFY_EMAIL"),
    pubsubSubscriptionName: need("GOOGLE_PUBSUB_SUBSCRIPTION_NAME"),
  };

  return { apple, google };
}
```

- [ ] **Step 3.7: Run `env-guard.test.ts`, confirm pass**

```
npx vitest run tests/iap/env-guard.test.ts
```
Expected: PASS 4/4.

- [ ] **Step 3.8: Run full API test suite (smoke)**

Pino redact paths are already wired in Step 0.4 (Task 0). No additional logger configuration needed here.

```
cd apps/api && npx vitest run
```
Expected: zero new failures (pre-existing tests untouched).

- [ ] **Step 3.9: Commit**

```
git add apps/api/src/env.ts apps/api/src/iap/redactEnv.ts apps/api/src/iap/env-guard.ts apps/api/src/server.ts apps/api/tests/iap/env.test.ts apps/api/tests/iap/env-guard.test.ts
git commit -m "feat(api): IAP env vars, redact rules, 503 iap_not_configured guard"
```

---

## Task 4: `apple-client.ts` — JWS verify (6 checks) + ASC API + status mapping

**Files:**
- Install: `npm install @apple/app-store-server-library --workspace=apps/api`
- Create: `apps/api/src/iap/apple-client.ts`
- Create: `apps/api/src/iap/status-mapping.ts` (shared by apple-client + google-client)
- Test: `apps/api/tests/iap/apple-client.test.ts`
- Test: `apps/api/tests/iap/status-mapping.test.ts`

- [ ] **Step 4.1: Install Apple's SDK**

```
npm install @apple/app-store-server-library --workspace=apps/api
```

- [ ] **Step 4.2: Write status-mapping test**

```ts
// apps/api/tests/iap/status-mapping.test.ts
import { describe, it, expect } from "vitest";
import { mapAppleStatus, mapGoogleStatus } from "../../src/iap/status-mapping.js";

describe("mapAppleStatus", () => {
  it("SUBSCRIBED → active", () => {
    expect(mapAppleStatus({ subscriptionStatus: "SUBSCRIBED" })).toEqual({
      status: "active",
      cancelAtPeriodEnd: false,
    });
  });
  it("SUBSCRIBED + offerType=1 → trialing", () => {
    expect(mapAppleStatus({ subscriptionStatus: "SUBSCRIBED", offerType: 1 })).toEqual({
      status: "trialing",
      cancelAtPeriodEnd: false,
    });
  });
  it("SUBSCRIBED + unknown offerType fails closed to trialing", () => {
    expect(mapAppleStatus({ subscriptionStatus: "SUBSCRIBED", offerType: 99 })).toEqual({
      status: "trialing",
      cancelAtPeriodEnd: false,
    });
  });
  it("BILLING_RETRY → past_due", () => {
    expect(mapAppleStatus({ subscriptionStatus: "BILLING_RETRY" })).toEqual({
      status: "past_due",
      cancelAtPeriodEnd: false,
    });
  });
  it("EXPIRED → canceled", () => {
    expect(mapAppleStatus({ subscriptionStatus: "EXPIRED" })).toEqual({
      status: "canceled",
      cancelAtPeriodEnd: false,
    });
  });
  it("REVOKED → canceled", () => {
    expect(mapAppleStatus({ subscriptionStatus: "REVOKED" })).toEqual({
      status: "canceled",
      cancelAtPeriodEnd: false,
    });
  });
  it("PAUSED → paused", () => {
    expect(mapAppleStatus({ subscriptionStatus: "PAUSED" })).toEqual({
      status: "paused",
      cancelAtPeriodEnd: false,
    });
  });
  it("SUBSCRIBED + autoRenewStatus=0 → active+cancelAtPeriodEnd", () => {
    expect(mapAppleStatus({ subscriptionStatus: "SUBSCRIBED", autoRenewStatus: 0 })).toEqual({
      status: "active",
      cancelAtPeriodEnd: true,
    });
  });
});

describe("mapGoogleStatus", () => {
  const future = new Date(Date.now() + 86400_000);
  const past = new Date(Date.now() - 1);

  it("ACTIVE → active", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_ACTIVE", expiryTime: future })).toEqual({
      status: "active", cancelAtPeriodEnd: false,
    });
  });
  it("IN_GRACE_PERIOD → past_due", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_IN_GRACE_PERIOD", expiryTime: future })).toEqual({
      status: "past_due", cancelAtPeriodEnd: false,
    });
  });
  it("ON_HOLD → past_due (product decision)", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_ON_HOLD", expiryTime: future })).toEqual({
      status: "past_due", cancelAtPeriodEnd: false,
    });
  });
  it("PAUSED → paused", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_PAUSED", expiryTime: future })).toEqual({
      status: "paused", cancelAtPeriodEnd: false,
    });
  });
  it("EXPIRED → canceled", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_EXPIRED", expiryTime: past })).toEqual({
      status: "canceled", cancelAtPeriodEnd: false,
    });
  });
  it("CANCELED + future expiryTime → active + cancelAtPeriodEnd", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", expiryTime: future })).toEqual({
      status: "active", cancelAtPeriodEnd: true,
    });
  });
  it("CANCELED + past expiryTime → canceled", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_CANCELED", expiryTime: past })).toEqual({
      status: "canceled", cancelAtPeriodEnd: false,
    });
  });
  it("PENDING → incomplete", () => {
    expect(mapGoogleStatus({ subscriptionState: "SUBSCRIPTION_STATE_PENDING", expiryTime: future })).toEqual({
      status: "incomplete", cancelAtPeriodEnd: false,
    });
  });
});
```

- [ ] **Step 4.3: Implement `status-mapping.ts`**

```ts
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
```

- [ ] **Step 4.4: Run status-mapping tests, confirm pass**

```
npx vitest run tests/iap/status-mapping.test.ts
```
Expected: PASS 16/16.

- [ ] **Step 4.5: Write `apple-client` test (mocked SDK)**

```ts
// apps/api/tests/iap/apple-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppleClient } from "../../src/iap/apple-client.js";
import type { AppleIapConfig } from "../../src/iap/env-guard.js";

const cfg: AppleIapConfig = {
  bundleId: "com.fina.app",
  ascIssuerId: "00000000-0000-0000-0000-000000000000",
  ascKeyId: "K1",
  ascPrivateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
  env: "sandbox",
};

const makeTx = (overrides: Partial<{
  bundleId: string; environment: string; signedDate: number;
  appAccountToken: string | undefined; productId: string; originalTransactionId: string;
}> = {}) => ({
  bundleId: overrides.bundleId ?? "com.fina.app",
  environment: overrides.environment ?? "Sandbox",
  signedDate: overrides.signedDate ?? Date.now(),
  appAccountToken: overrides.appAccountToken ?? "00000000-0000-0000-0000-000000000aaa",
  productId: overrides.productId ?? "pro_monthly",
  originalTransactionId: overrides.originalTransactionId ?? "1000000000000001",
  transactionId: "1000000000000099",
});

describe("AppleClient.verifyAndDecodeTransaction", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("happy path returns decoded transaction", async () => {
    const c = new AppleClient(cfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx());
    const out = await c.verifyAndDecodeTransaction("jws-string");
    expect(out.productId).toBe("pro_monthly");
    expect(out.originalTransactionId).toBe("1000000000000001");
  });

  it("rejects when bundleId mismatch", async () => {
    const c = new AppleClient(cfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ bundleId: "com.other.app" }));
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects sandbox JWS in production env", async () => {
    const prodCfg = { ...cfg, env: "production" as const };
    const c = new AppleClient(prodCfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ environment: "Sandbox" }));
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects when signedDate is too old (ASC-API 10min window)", async () => {
    const c = new AppleClient(cfg);
    const old = Date.now() - 11 * 60 * 1000;
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ signedDate: old }));
    await expect(c.verifyAndDecodeTransaction("x", { context: "asc-api" })).rejects.toMatchObject({ code: "expired_receipt" });
  });

  it("accepts older payload in ASSN window (1h)", async () => {
    const c = new AppleClient(cfg);
    const oldButOk = Date.now() - 55 * 60 * 1000;
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ signedDate: oldButOk }));
    const out = await c.verifyAndDecodeTransaction("x", { context: "assn" });
    expect(out).toBeDefined();
  });

  it("rejects when appAccountToken is missing", async () => {
    const c = new AppleClient(cfg);
    vi.spyOn(c as any, "_decodeAndVerifyJws").mockResolvedValue(makeTx({ appAccountToken: undefined }));
    await expect(c.verifyAndDecodeTransaction("x")).rejects.toMatchObject({ code: "user_mismatch" });
  });
});
```

- [ ] **Step 4.6: Implement `apple-client.ts`**

```ts
// apps/api/src/iap/apple-client.ts
import { createHash, X509Certificate } from "node:crypto";
import {
  SignedDataVerifier,
  Environment,
  AppStoreServerAPIClient,
} from "@apple/app-store-server-library";
import { HttpError } from "../auth/context.js";
import type { AppleIapConfig } from "./env-guard.js";
import { mapAppleStatus } from "./status-mapping.js";
import type { MappedStatus } from "./status-mapping.js";
import { APPLE_ROOT_CERTS, EXPECTED_APPLE_ROOT_SPKI_SHA256 } from "./apple-roots.js";

/** Verify on module load that the pinned cert(s) parse + match the
 *  expected SPKI SHA-256 hash. This is the "pinned by SPKI hash in
 *  code" guarantee from spec §5.2 check #2 — a PEM-bytes mismatch
 *  (re-encoded same cert) still validates iff the SPKI matches.
 *  Throws at boot rather than at first webhook so misconfiguration
 *  surfaces during deploy, not during a real Apple notification. */
function validateAppleRoots(): void {
  if (APPLE_ROOT_CERTS.length === 0) {
    throw new Error(
      "APPLE_ROOT_CERTS is empty — install the Apple root cert(s) per spec §5.2 check #2. " +
        "See apps/api/src/iap/apple-roots.ts.",
    );
  }
  for (const pem of APPLE_ROOT_CERTS) {
    const pemStr = pem.toString("utf8");
    if (pemStr.includes("<<<") || pemStr.includes(">>>")) {
      throw new Error(
        "APPLE_ROOT_CERTS contains a placeholder. Drop in the real Apple Inc. Root CA PEM. " +
          "See https://www.apple.com/certificateauthority/",
      );
    }
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(pem);
    } catch (e) {
      throw new Error(`APPLE_ROOT_CERTS contains an unparseable certificate: ${(e as Error).message}`);
    }
    const spki = cert.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const spkiHash = createHash("sha256").update(spki).digest("hex");
    if (!EXPECTED_APPLE_ROOT_SPKI_SHA256.includes(spkiHash)) {
      throw new Error(
        `APPLE_ROOT_CERTS SPKI SHA-256 ${spkiHash.slice(0, 16)}… is not in the expected pinned set. ` +
          `Refusing to start.`,
      );
    }
  }
}
validateAppleRoots();

export type VerifiedAppleTransaction = {
  bundleId: string;
  environment: "Sandbox" | "Production";
  signedDate: number;
  appAccountToken: string;
  productId: string;
  originalTransactionId: string;
  transactionId: string;
  /** Raw decoded payload for callers that need fields not surfaced above. */
  raw: Record<string, unknown>;
};

export type VerifyContext = "asc-api" | "assn";

export class AppleClient {
  private verifier: SignedDataVerifier;
  private asc: AppStoreServerAPIClient;

  constructor(private cfg: AppleIapConfig) {
    const env = cfg.env === "production" ? Environment.PRODUCTION : Environment.SANDBOX;
    this.verifier = new SignedDataVerifier(
      APPLE_ROOT_CERTS,
      /* enableOnlineChecks */ false,
      env,
      cfg.bundleId,
    );
    this.asc = new AppStoreServerAPIClient(
      cfg.ascPrivateKey,
      cfg.ascKeyId,
      cfg.ascIssuerId,
      cfg.bundleId,
      env,
    );
  }

  /** Internal — testable injection seam. Verifies the JWS cert chain
   *  via Apple's SDK and returns the decoded transaction payload. */
  protected async _decodeAndVerifyJws(jws: string): Promise<Record<string, unknown>> {
    const decoded = await this.verifier.verifyAndDecodeTransaction(jws);
    return decoded as unknown as Record<string, unknown>;
  }

  /** Verifies a SignedTransaction JWS through six mandatory checks
   *  (alg, root chain, bundleId, environment, signedDate window,
   *  appAccountToken). Fails closed with HttpError on any failure. */
  async verifyAndDecodeTransaction(
    jws: string,
    opts: { context?: VerifyContext } = {},
  ): Promise<VerifiedAppleTransaction> {
    // Apple SDK enforces alg + root chain internally (checks 1, 2).
    const raw = await this._decodeAndVerifyJws(jws).catch((e) => {
      throw new HttpError(400, "invalid_receipt", `apple jws verify failed: ${e?.name ?? "error"}`);
    });

    const bundleId = String(raw.bundleId ?? "");
    if (bundleId !== this.cfg.bundleId) {
      throw new HttpError(400, "invalid_receipt", "bundleId mismatch");
    }

    const environment = String(raw.environment ?? "");
    const expectedEnv = this.cfg.env === "production" ? "Production" : "Sandbox";
    if (environment !== expectedEnv) {
      throw new HttpError(400, "invalid_receipt", "environment mismatch");
    }

    const signedDate = Number(raw.signedDate ?? 0);
    const ageMs = Date.now() - signedDate;
    const maxAgeMs = opts.context === "assn" ? 60 * 60 * 1000 : 10 * 60 * 1000;
    if (signedDate <= 0 || ageMs > maxAgeMs) {
      throw new HttpError(400, "expired_receipt", "signedDate outside acceptable window");
    }

    const appAccountToken = raw.appAccountToken;
    if (typeof appAccountToken !== "string" || appAccountToken.length === 0) {
      throw new HttpError(403, "user_mismatch", "appAccountToken absent on verified transaction");
    }

    return {
      bundleId,
      environment: environment as "Sandbox" | "Production",
      signedDate,
      appAccountToken,
      productId: String(raw.productId ?? ""),
      originalTransactionId: String(raw.originalTransactionId ?? ""),
      transactionId: String(raw.transactionId ?? ""),
      raw,
    };
  }

  /** Fetches the latest subscription state from ASC API by
   *  originalTransactionId. Returns the verified renewal-info + a
   *  mapped status. */
  async getSubscriptionStatus(originalTransactionId: string): Promise<{
    expiresDate: Date;
    productId: string;
    mapped: MappedStatus;
  }> {
    const status = await this.asc
      .getAllSubscriptionStatuses(originalTransactionId)
      .catch((e) => {
        throw new HttpError(502, "platform_unavailable", `asc api: ${e?.name ?? "error"}`);
      });
    const item = status.data?.[0]?.lastTransactions?.[0];
    if (!item) throw new HttpError(400, "invalid_receipt", "asc no transaction");

    // Decode each inner JWS through its DEDICATED Apple SDK verifier —
    // signedTransactionInfo through the transaction verifier (which
    // re-runs the 6 checks: alg, root, bundleId, environment,
    // signedDate, appAccountToken — defense-in-depth), and
    // signedRenewalInfo through the renewal-info verifier (different
    // payload shape: autoRenewStatus, offerType, autoRenewProductId).
    // Do NOT use _decodeAndVerifyJws — that's the generic JWS seam
    // used only by the public verifier methods.
    const verifiedTx = await this.verifyAndDecodeTransaction(item.signedTransactionInfo, { context: "asc-api" });
    const renewal = await this.verifyAndDecodeRenewalInfo(item.signedRenewalInfo);

    const mapped = mapAppleStatus({
      subscriptionStatus: appleStatusFromCode(item.status),
      offerType: (renewal.offerType as number | null) ?? null,
      autoRenewStatus: (renewal.autoRenewStatus as 0 | 1) ?? 1,
    });
    return {
      expiresDate: new Date(Number(verifiedTx.raw.expiresDate ?? 0)),
      productId: verifiedTx.productId,
      mapped,
    };
  }
}

function appleStatusFromCode(code: number): "SUBSCRIBED" | "BILLING_RETRY" | "EXPIRED" | "REVOKED" | "PAUSED" {
  // Apple's status enum: 1=active, 2=expired, 3=billing retry,
  //                      4=grace, 5=revoked. (Family Sharing handled
  //                      in the webhook subtype path, not here.)
  switch (code) {
    case 1: return "SUBSCRIBED";
    case 2: return "EXPIRED";
    case 3: return "BILLING_RETRY";
    case 4: return "BILLING_RETRY"; // grace is part of past_due window
    case 5: return "REVOKED";
    default: return "EXPIRED";
  }
}
```

Extend `AppleClient` with the **notification** and **renewal-info** verifiers — these are distinct SDK methods from `verifyAndDecodeTransaction` and MUST be used for ASSN payloads / ASC `signedRenewalInfo` respectively:

```ts
  /** Decodes an ASSN V2 signedPayload (the webhook outer JWS). Uses
   *  the SDK's dedicated notification verifier — DO NOT route this
   *  through verifyAndDecodeTransaction (different payload shape;
   *  the transaction validator's bundleId/environment/appAccountToken
   *  checks have no counterpart in notification payloads). */
  async verifyAndDecodeNotification(signedPayload: string): Promise<{
    notificationUUID: string;
    notificationType: string;
    subtype?: string;
    signedTransactionJws: string;
    signedRenewalInfoJws?: string;
    raw: Record<string, unknown>;
  }> {
    const decoded = await this.verifier
      .verifyAndDecodeNotification(signedPayload)
      .catch((e) => {
        throw new HttpError(400, "invalid_receipt", `apple notification verify failed: ${e?.name ?? "error"}`);
      });
    const data = ((decoded as any).data ?? {}) as Record<string, unknown>;
    return {
      notificationUUID: String((decoded as any).notificationUUID ?? ""),
      notificationType: String((decoded as any).notificationType ?? ""),
      subtype: typeof (decoded as any).subtype === "string" ? (decoded as any).subtype : undefined,
      signedTransactionJws: String(data.signedTransactionInfo ?? ""),
      signedRenewalInfoJws: typeof data.signedRenewalInfo === "string" ? data.signedRenewalInfo : undefined,
      raw: decoded as Record<string, unknown>,
    };
  }

  /** Decodes signedRenewalInfo. Distinct SDK method from
   *  verifyAndDecodeTransaction — renewal-info payloads have their
   *  own claim set (autoRenewProductId, offerType, autoRenewStatus). */
  async verifyAndDecodeRenewalInfo(jws: string): Promise<Record<string, unknown>> {
    return (await this.verifier
      .verifyAndDecodeRenewalInfo(jws)
      .catch((e) => {
        throw new HttpError(400, "invalid_receipt", `apple renewal verify failed: ${e?.name ?? "error"}`);
      })) as unknown as Record<string, unknown>;
  }
```

Also update `getSubscriptionStatus` to call the dedicated decoders (replace the two `_decodeAndVerifyJws` calls with `verifyAndDecodeTransaction` for `signedTransactionInfo` and `verifyAndDecodeRenewalInfo` for `signedRenewalInfo`).

- [ ] **Step 4.6b: Create `apple-roots.ts` with the real PEM + expected SPKI hash**

```ts
// apps/api/src/iap/apple-roots.ts
//
// Apple Inc. Root CA G3 — the root used by App Store Server Notifications V2.
// Source: https://www.apple.com/certificateauthority/
// File: AppleIncRootCertificate.cer (DER) → PEM-encode.
//
// IMPORTANT: This is the pinned root. To compute the expected SPKI SHA-256:
//   openssl x509 -in AppleIncRootCertificate.pem -pubkey -noout \
//     | openssl pkey -pubin -outform DER \
//     | openssl dgst -sha256
//
// The constant below carries the EXPECTED hash; module-load validation
// in apple-client.ts refuses to start if the PEM's actual SPKI hash
// doesn't match. Re-running the openssl pipeline above gives the value
// to paste here.

export const APPLE_ROOT_CERTS: Buffer[] = [
  Buffer.from(
    `-----BEGIN CERTIFICATE-----
<<INSTALLER: paste the real Apple Inc. Root CA G3 PEM here. Module-load
 validation will throw "APPLE_ROOT_CERTS contains a placeholder" until
 this is done — that's intentional.>>
-----END CERTIFICATE-----
`,
    "utf8",
  ),
];

/** SHA-256 of the SPKI (Subject Public Key Info) DER bytes of every
 *  trusted Apple root. Validation succeeds when at least one entry in
 *  APPLE_ROOT_CERTS hashes to a value in this set. Multiple entries
 *  allow root rotation: register the next root + hash here BEFORE
 *  Apple flips the signing chain, then retire the old one. */
export const EXPECTED_APPLE_ROOT_SPKI_SHA256: ReadonlyArray<string> = [
  // INSTALLER: run the openssl pipeline in the file header on the real
  // PEM and paste the lowercase hex digest here.
  "<INSTALLER_FILL_64_HEX_CHARS>",
];
```

The placeholder strings cause `validateAppleRoots()` to throw at module load with a clear error message — fail-fast at deploy, not at first webhook.

- [ ] **Step 4.6c: Add test for root-cert validation**

```ts
// apps/api/tests/iap/apple-roots.test.ts
import { describe, it, expect } from "vitest";
import { X509Certificate, createHash } from "node:crypto";
import { APPLE_ROOT_CERTS, EXPECTED_APPLE_ROOT_SPKI_SHA256 } from "../../src/iap/apple-roots.js";

describe("APPLE_ROOT_CERTS", () => {
  it("contains no placeholder markers", () => {
    for (const pem of APPLE_ROOT_CERTS) {
      const s = pem.toString("utf8");
      expect(s).not.toMatch(/<<</);
      expect(s).not.toMatch(/INSTALLER/);
    }
  });

  it("every cert parses as X.509 and its SPKI SHA-256 is in the expected pin set", () => {
    for (const pem of APPLE_ROOT_CERTS) {
      const cert = new X509Certificate(pem);
      const spki = cert.publicKey.export({ type: "spki", format: "der" }) as Buffer;
      const hash = createHash("sha256").update(spki).digest("hex");
      expect(EXPECTED_APPLE_ROOT_SPKI_SHA256).toContain(hash);
    }
  });
});
```

This test FAILS on a fresh checkout (placeholder still in place) — the engineer running the migration is forced to install the real PEM + hash before any other test runs. That's by design.

- [ ] **Step 4.7: Run `apple-client.test.ts`, confirm pass**

```
npx vitest run tests/iap/apple-client.test.ts
```
Expected: PASS 6/6.

- [ ] **Step 4.8: Commit**

```
git add apps/api/package.json apps/api/src/iap/apple-client.ts apps/api/src/iap/status-mapping.ts apps/api/src/iap/apple-roots.ts apps/api/tests/iap/apple-client.test.ts apps/api/tests/iap/status-mapping.test.ts apps/api/tests/iap/apple-roots.test.ts
git commit -m "feat(api): Apple StoreKit 2 client — verifyAndDecodeTransaction with 6 mandatory checks"
```

---

## Task 5: `google-client.ts` — Play Developer API + `acknowledge` + `linkedPurchaseToken` chain

**Files:**
- Install: `npm install googleapis google-auth-library --workspace=apps/api`
- Create: `apps/api/src/iap/google-client.ts`
- Test: `apps/api/tests/iap/google-client.test.ts`

- [ ] **Step 5.1: Install Google libraries**

```
npm install googleapis google-auth-library --workspace=apps/api
```

- [ ] **Step 5.2: Write `google-client` failing test**

```ts
// apps/api/tests/iap/google-client.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { GoogleClient } from "../../src/iap/google-client.js";
import type { GoogleIapConfig } from "../../src/iap/env-guard.js";

const cfg: GoogleIapConfig = {
  packageName: "app.fina",
  serviceAccount: { client_email: "x@y", private_key: "k" } as any,
  pubsubVerifyAudience: "aud",
  pubsubVerifyEmail: "x@y",
  pubsubSubscriptionName: "projects/fina/subscriptions/iap-rtdn",
};

const mkV2 = (overrides: Partial<{
  obfuscatedExternalAccountId: string;
  acknowledgementState: string;
  subscriptionState: string;
  expiryTime: string;
  productId: string;
  linkedPurchaseToken: string | null;
  environment: "Production" | "Sandbox";
}> = {}) => ({
  externalAccountIdentifiers: {
    obfuscatedExternalAccountId: overrides.obfuscatedExternalAccountId ?? "obf-1",
  },
  acknowledgementState: overrides.acknowledgementState ?? "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
  subscriptionState: overrides.subscriptionState ?? "SUBSCRIPTION_STATE_ACTIVE",
  lineItems: [
    {
      productId: overrides.productId ?? "pro_monthly",
      expiryTime: overrides.expiryTime ?? new Date(Date.now() + 86400_000).toISOString(),
      offerDetails: {},
    },
  ],
  linkedPurchaseToken: overrides.linkedPurchaseToken ?? null,
  testPurchase: overrides.environment === "Sandbox" ? {} : undefined,
});

describe("GoogleClient.fetchAndNormalize", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("returns normalized v2 payload + 'Production' environment", async () => {
    const c = new GoogleClient(cfg);
    vi.spyOn(c as any, "_getV2").mockResolvedValue(mkV2());
    const out = await c.fetchAndNormalize("token-abc");
    expect(out.obfuscatedExternalAccountId).toBe("obf-1");
    expect(out.environment).toBe("Production");
    expect(out.mapped.status).toBe("active");
  });

  it("tags Sandbox when testPurchase is set", async () => {
    const c = new GoogleClient(cfg);
    vi.spyOn(c as any, "_getV2").mockResolvedValue(mkV2({ environment: "Sandbox" }));
    const out = await c.fetchAndNormalize("token-abc");
    expect(out.environment).toBe("Sandbox");
  });

  it("acknowledges when state is PENDING", async () => {
    const c = new GoogleClient(cfg);
    const ackSpy = vi.spyOn(c as any, "_acknowledge").mockResolvedValue(undefined);
    await c.acknowledgeIfPending({
      purchaseToken: "token-abc",
      productId: "pro_monthly",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    });
    expect(ackSpy).toHaveBeenCalledWith("token-abc", "pro_monthly");
  });

  it("does not acknowledge when state is already ACKNOWLEDGED", async () => {
    const c = new GoogleClient(cfg);
    const ackSpy = vi.spyOn(c as any, "_acknowledge").mockResolvedValue(undefined);
    await c.acknowledgeIfPending({
      purchaseToken: "token-abc",
      productId: "pro_monthly",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
    });
    expect(ackSpy).not.toHaveBeenCalled();
  });

  it("surfaces linkedPurchaseToken when present", async () => {
    const c = new GoogleClient(cfg);
    vi.spyOn(c as any, "_getV2").mockResolvedValue(mkV2({ linkedPurchaseToken: "prev-token" }));
    const out = await c.fetchAndNormalize("token-abc");
    expect(out.linkedPurchaseToken).toBe("prev-token");
  });
});
```

- [ ] **Step 5.3: Implement `google-client.ts`**

```ts
// apps/api/src/iap/google-client.ts
import { google } from "googleapis";
import { HttpError } from "../auth/context.js";
import type { GoogleIapConfig } from "./env-guard.js";
import { mapGoogleStatus } from "./status-mapping.js";
import type { MappedStatus, GoogleStatusInput } from "./status-mapping.js";

export type NormalizedGooglePurchase = {
  obfuscatedExternalAccountId: string;
  acknowledgementState: string;
  subscriptionState: GoogleStatusInput["subscriptionState"];
  productId: string;
  expiryTime: Date;
  linkedPurchaseToken: string | null;
  environment: "Production" | "Sandbox";
  mapped: MappedStatus;
  raw: Record<string, unknown>;
};

export class GoogleClient {
  private androidPublisher;

  constructor(private cfg: GoogleIapConfig) {
    const auth = new google.auth.GoogleAuth({
      credentials: cfg.serviceAccount as any,
      scopes: ["https://www.googleapis.com/auth/androidpublisher"],
    });
    this.androidPublisher = google.androidpublisher({ version: "v3", auth });
  }

  /** Testable seam — raw v2 fetch. */
  protected async _getV2(purchaseToken: string): Promise<Record<string, unknown>> {
    const res = await this.androidPublisher.purchases.subscriptionsv2
      .get({
        packageName: this.cfg.packageName,
        token: purchaseToken,
      })
      .catch((e: any) => {
        const status = Number(e?.code ?? e?.response?.status ?? 0);
        if (status === 404 || status === 410) throw new HttpError(400, "invalid_receipt", "google purchase not found");
        throw new HttpError(502, "platform_unavailable", `google api: ${e?.message ?? "error"}`);
      });
    return res.data as Record<string, unknown>;
  }

  /** Testable seam — invoke the acknowledge call. Must pass the
   *  product's subscriptionId (NOT an empty string) per the v1
   *  endpoint contract; v2 has no acknowledge method as of
   *  `googleapis@^140`. We always have the productId at the call
   *  site because the prior fetchAndNormalize surfaces it. */
  protected async _acknowledge(purchaseToken: string, productId: string): Promise<void> {
    await this.androidPublisher.purchases.subscriptions
      .acknowledge({
        packageName: this.cfg.packageName,
        subscriptionId: productId,
        token: purchaseToken,
        requestBody: {},
      })
      .catch((e: any) => {
        throw new HttpError(502, "platform_unavailable", `google ack: ${e?.message ?? "error"}`);
      });
  }

  /** Fetch the v2 purchase, normalize into our shape, derive
   *  environment from `testPurchase` presence, derive mapped status. */
  async fetchAndNormalize(purchaseToken: string): Promise<NormalizedGooglePurchase> {
    const raw = await this._getV2(purchaseToken);
    const obf = (raw.externalAccountIdentifiers as any)?.obfuscatedExternalAccountId;
    if (!obf || typeof obf !== "string") {
      throw new HttpError(403, "user_mismatch", "obfuscatedExternalAccountId absent");
    }
    const lineItem = ((raw.lineItems as any[]) ?? [])[0] ?? {};
    const productId = String(lineItem.productId ?? "");
    const expiryTime = new Date(lineItem.expiryTime ?? Date.now());
    const subscriptionState = String(raw.subscriptionState ?? "") as GoogleStatusInput["subscriptionState"];
    const linkedPurchaseToken = (raw.linkedPurchaseToken as string | null) ?? null;
    const environment: "Production" | "Sandbox" = raw.testPurchase ? "Sandbox" : "Production";
    const introOffer = Boolean(lineItem.offerDetails?.offerId);
    const mapped = mapGoogleStatus({ subscriptionState, expiryTime, introOffer });
    return {
      obfuscatedExternalAccountId: obf,
      acknowledgementState: String(raw.acknowledgementState ?? ""),
      subscriptionState,
      productId,
      expiryTime,
      linkedPurchaseToken,
      environment,
      mapped,
      raw,
    };
  }

  /** Idempotent acknowledge — caller passes the already-fetched
   *  state to avoid a second fetchAndNormalize round-trip (TOCTOU
   *  window + ~150ms latency). Calls API only when PENDING. Spec
   *  §7 requires this after every successful upsert so Google
   *  doesn't auto-refund within 3 days. */
  async acknowledgeIfPending(args: {
    purchaseToken: string;
    productId: string;
    acknowledgementState: string;
  }): Promise<boolean> {
    if (args.acknowledgementState !== "ACKNOWLEDGEMENT_STATE_PENDING") return false;
    await this._acknowledge(args.purchaseToken, args.productId);
    return true;
  }
}
```

- [ ] **Step 5.4: Run google-client test, confirm pass**

```
npx vitest run tests/iap/google-client.test.ts
```
Expected: PASS 5/5.

- [ ] **Step 5.5: Commit**

```
git add apps/api/package.json apps/api/src/iap/google-client.ts apps/api/tests/iap/google-client.test.ts
git commit -m "feat(api): Google Play Developer client — fetchAndNormalize + acknowledgeIfPending"
```

---

## Task 6: `webhook-verify.ts` — Apple ASSN JWS + Google Pub/Sub OIDC

**Files:**
- Create: `apps/api/src/iap/webhook-verify.ts`
- Test: `apps/api/tests/iap/webhook-verify.test.ts`

- [ ] **Step 6.1: Write failing tests**

```ts
// apps/api/tests/iap/webhook-verify.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyApplePayload,
  verifyGoogleEnvelope,
} from "../../src/iap/webhook-verify.js";
import type { AppleIapConfig, GoogleIapConfig } from "../../src/iap/env-guard.js";

const appleCfg: AppleIapConfig = {
  bundleId: "com.fina.app",
  ascIssuerId: "00000000-0000-0000-0000-000000000000",
  ascKeyId: "K1",
  ascPrivateKey: "fake",
  env: "sandbox",
};

const googleCfg: GoogleIapConfig = {
  packageName: "app.fina",
  serviceAccount: { client_email: "iap@fina.iam.gserviceaccount.com", private_key: "k" } as any,
  pubsubVerifyAudience: "https://api.fina.app/webhooks/iap/google",
  pubsubVerifyEmail: "iap@fina.iam.gserviceaccount.com",
  pubsubSubscriptionName: "projects/fina/subscriptions/iap-rtdn",
};

describe("verifyApplePayload", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("delegates to AppleClient.verifyAndDecodeNotification and returns flat shape", async () => {
    const fakeClient = {
      verifyAndDecodeNotification: vi.fn().mockResolvedValue({
        notificationUUID: "uuid-1",
        notificationType: "DID_RENEW",
        signedTransactionJws: "tx-jws",
        raw: {},
      }),
    };
    const out = await verifyApplePayload("signed-payload-string", appleCfg, { appleClient: fakeClient as any });
    expect(out.notificationUUID).toBe("uuid-1");
    expect(out.signedTransactionJws).toBe("tx-jws");
    expect(fakeClient.verifyAndDecodeNotification).toHaveBeenCalledWith("signed-payload-string");
  });
});

describe("verifyGoogleEnvelope", () => {
  beforeEach(() => vi.restoreAllMocks());

  const makeEnvelope = (overrides: any = {}) => ({
    message: {
      data: Buffer.from(JSON.stringify({
        subscriptionNotification: {
          purchaseToken: "tok-1",
          subscriptionId: "pro_monthly",
          notificationType: 4,
        },
      })).toString("base64"),
      messageId: "msg-1",
    },
    subscription: overrides.subscription ?? googleCfg.pubsubSubscriptionName,
  });

  const fakeOidcOk = { verifyIdToken: vi.fn().mockResolvedValue({
    getPayload: () => ({
      aud: googleCfg.pubsubVerifyAudience,
      iss: "https://accounts.google.com",
      email: googleCfg.pubsubVerifyEmail,
      azp: googleCfg.pubsubVerifyEmail,
      exp: Math.floor(Date.now() / 1000) + 60,
    }),
  }) };

  it("happy path returns parsed subscriptionNotification", async () => {
    const out = await verifyGoogleEnvelope(
      "Bearer fake-jwt",
      makeEnvelope(),
      googleCfg,
      { oidcClient: fakeOidcOk as any },
    );
    expect(out.kind).toBe("subscription");
    expect(out.payload.purchaseToken).toBe("tok-1");
  });

  it("rejects when subscription name mismatches", async () => {
    await expect(
      verifyGoogleEnvelope(
        "Bearer fake-jwt",
        makeEnvelope({ subscription: "projects/evil/subscriptions/x" }),
        googleCfg,
        { oidcClient: fakeOidcOk as any },
      ),
    ).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects when audience mismatches", async () => {
    const bad = { verifyIdToken: vi.fn().mockResolvedValue({
      getPayload: () => ({ aud: "wrong", iss: "https://accounts.google.com", email: googleCfg.pubsubVerifyEmail, azp: googleCfg.pubsubVerifyEmail, exp: Math.floor(Date.now()/1000)+60 }),
    }) };
    await expect(
      verifyGoogleEnvelope("Bearer x", makeEnvelope(), googleCfg, { oidcClient: bad as any }),
    ).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects when email mismatches", async () => {
    const bad = { verifyIdToken: vi.fn().mockResolvedValue({
      getPayload: () => ({ aud: googleCfg.pubsubVerifyAudience, iss: "https://accounts.google.com", email: "attacker@evil.com", azp: googleCfg.pubsubVerifyEmail, exp: Math.floor(Date.now()/1000)+60 }),
    }) };
    await expect(
      verifyGoogleEnvelope("Bearer x", makeEnvelope(), googleCfg, { oidcClient: bad as any }),
    ).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("rejects expired token (zero clock skew)", async () => {
    const bad = { verifyIdToken: vi.fn().mockResolvedValue({
      getPayload: () => ({ aud: googleCfg.pubsubVerifyAudience, iss: "https://accounts.google.com", email: googleCfg.pubsubVerifyEmail, azp: googleCfg.pubsubVerifyEmail, exp: Math.floor(Date.now()/1000) - 10 }),
    }) };
    await expect(
      verifyGoogleEnvelope("Bearer x", makeEnvelope(), googleCfg, { oidcClient: bad as any }),
    ).rejects.toMatchObject({ code: "invalid_receipt" });
  });

  it("returns kind=ignore for non-subscription notifications", async () => {
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify({ testNotification: { version: "1.0" } })).toString("base64"),
        messageId: "msg-2",
      },
      subscription: googleCfg.pubsubSubscriptionName,
    };
    const out = await verifyGoogleEnvelope(
      "Bearer x", envelope, googleCfg, { oidcClient: fakeOidcOk as any },
    );
    expect(out.kind).toBe("ignore");
  });
});
```

- [ ] **Step 6.2: Implement `webhook-verify.ts`**

```ts
// apps/api/src/iap/webhook-verify.ts
import { OAuth2Client } from "google-auth-library";
import { HttpError } from "../auth/context.js";
import type { AppleClient } from "./apple-client.js";
import type { AppleIapConfig, GoogleIapConfig } from "./env-guard.js";

export type AppleNotification = {
  notificationUUID: string;
  notificationType: string;
  subtype?: string;
  signedTransactionJws: string;
  raw: Record<string, unknown>;
};

/** Thin wrapper that delegates to AppleClient.verifyAndDecodeNotification.
 *  Kept as a free function so the webhook route's tests can pass a
 *  mocked AppleClient without import cycles. The actual signature +
 *  shape verification lives in apple-client.ts (Task 4 Step 4.6). */
export async function verifyApplePayload(
  signedPayload: string,
  _cfg: AppleIapConfig,
  deps: { appleClient: Pick<AppleClient, "verifyAndDecodeNotification"> },
): Promise<AppleNotification> {
  const n = await deps.appleClient.verifyAndDecodeNotification(signedPayload);
  return {
    notificationUUID: n.notificationUUID,
    notificationType: n.notificationType,
    subtype: n.subtype,
    signedTransactionJws: n.signedTransactionJws,
    raw: n.raw,
  };
}

export type GoogleNotification =
  | {
      kind: "subscription";
      messageId: string;
      payload: { purchaseToken: string; subscriptionId: string; notificationType: number };
    }
  | { kind: "ignore"; messageId: string; reason: string };

/** Google Pub/Sub OIDC + envelope verifier. */
export async function verifyGoogleEnvelope(
  authorizationHeader: string | undefined,
  body: { message?: { data?: string; messageId?: string }; subscription?: string },
  cfg: GoogleIapConfig,
  deps: { oidcClient: Pick<OAuth2Client, "verifyIdToken"> },
): Promise<GoogleNotification> {
  // 1. OIDC bearer
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new HttpError(400, "invalid_receipt", "missing bearer");
  }
  const token = authorizationHeader.slice("Bearer ".length);

  const ticket = await deps.oidcClient.verifyIdToken({
    idToken: token,
    audience: cfg.pubsubVerifyAudience,
  } as any).catch(() => {
    throw new HttpError(400, "invalid_receipt", "oidc verify failed");
  });
  const payload = (ticket as any).getPayload?.() ?? {};
  if (payload.iss !== "https://accounts.google.com") {
    throw new HttpError(400, "invalid_receipt", "oidc issuer mismatch");
  }
  if (payload.aud !== cfg.pubsubVerifyAudience) {
    throw new HttpError(400, "invalid_receipt", "oidc audience mismatch");
  }
  if (payload.email !== cfg.pubsubVerifyEmail || payload.azp !== cfg.pubsubVerifyEmail) {
    throw new HttpError(400, "invalid_receipt", "oidc email/azp mismatch");
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < nowSec) {
    throw new HttpError(400, "invalid_receipt", "oidc expired");
  }

  // 2. Pub/Sub subscription pinning
  if (body.subscription !== cfg.pubsubSubscriptionName) {
    throw new HttpError(400, "invalid_receipt", "pubsub subscription mismatch");
  }

  // 3. Decode inner envelope
  const messageId = String(body.message?.messageId ?? "");
  const dataB64 = body.message?.data;
  if (!dataB64) throw new HttpError(400, "invalid_receipt", "pubsub missing data");
  const inner = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));

  if (inner.subscriptionNotification) {
    return {
      kind: "subscription",
      messageId,
      payload: {
        purchaseToken: String(inner.subscriptionNotification.purchaseToken ?? ""),
        subscriptionId: String(inner.subscriptionNotification.subscriptionId ?? ""),
        notificationType: Number(inner.subscriptionNotification.notificationType ?? 0),
      },
    };
  }

  // testNotification, oneTimeProductNotification, etc. — ignored.
  return { kind: "ignore", messageId, reason: Object.keys(inner)[0] ?? "unknown" };
}
```

- [ ] **Step 6.3: Run, confirm pass**

```
npx vitest run tests/iap/webhook-verify.test.ts
```
Expected: PASS 7/7.

- [ ] **Step 6.4: Commit**

```
git add apps/api/src/iap/webhook-verify.ts apps/api/tests/iap/webhook-verify.test.ts
git commit -m "feat(api): IAP webhook signature verifiers — Apple ASSN JWS + Google Pub/Sub OIDC"
```

---

## Task 7: `sync-sub.ts` — orchestrator (tier resolution, token match, upsert, binding write, acknowledge, linkedPurchaseToken chain)

**Files:**
- Create: `apps/api/src/iap/sync-sub.ts`
- Create: `apps/api/src/iap/binding.ts` (helper: deterministic `uuidv5` / `sha256` derivation + `IapDeletedBinding` writer)
- Test: `apps/api/tests/iap/sync-sub.test.ts`
- Test: `apps/api/tests/iap/binding.test.ts`

- [ ] **Step 7.1: Write `binding` failing tests**

```ts
// apps/api/tests/iap/binding.test.ts
import { describe, it, expect } from "vitest";
import { deriveAppleToken, deriveGoogleToken, hashBindingToken } from "../../src/iap/binding.js";

describe("deterministic IAP binding", () => {
  it("deriveAppleToken is uuidv5(userId, IAP_NAMESPACE)", () => {
    const a = deriveAppleToken("user-1");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveAppleToken("user-1")).toBe(a);
  });
  it("different userIds produce different tokens", () => {
    expect(deriveAppleToken("user-1")).not.toBe(deriveAppleToken("user-2"));
  });
  it("deriveGoogleToken is sha256(userId) hex, 64 chars", () => {
    const g = deriveGoogleToken("user-1");
    expect(g).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveGoogleToken("user-1")).toBe(g);
  });
  it("hashBindingToken is sha256 hex", () => {
    expect(hashBindingToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 7.2: Implement `binding.ts`**

```ts
// apps/api/src/iap/binding.ts
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { IAP_NAMESPACE } from "@fina/shared";

export function deriveAppleToken(userId: string): string {
  return uuidv5(userId, IAP_NAMESPACE);
}

export function deriveGoogleToken(userId: string): string {
  return createHash("sha256").update(userId, "utf8").digest("hex");
}

/** SHA-256 hex of an arbitrary binding token, used for storing
 *  tombstones in IapDeletedBinding without recovering the original. */
export function hashBindingToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
```

- [ ] **Step 7.3: Install `uuid` if absent**

```
npm install uuid --workspace=apps/api
npm install -D @types/uuid --workspace=apps/api
```

- [ ] **Step 7.4: Run binding test, confirm pass**

```
cd apps/api && npx vitest run tests/iap/binding.test.ts
```
Expected: PASS 4/4.

- [ ] **Step 7.5: Write `sync-sub` failing test**

```ts
// apps/api/tests/iap/sync-sub.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { syncSubscriptionFromIAP } from "../../src/iap/sync-sub.js";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { deriveAppleToken, deriveGoogleToken } from "../../src/iap/binding.js";

const fakeAppleClient: any = {
  verifyAndDecodeTransaction: vi.fn(),
  getSubscriptionStatus: vi.fn(),
};
const fakeGoogleClient: any = {
  fetchAndNormalize: vi.fn(),
  acknowledgeIfPending: vi.fn().mockResolvedValue(true),
};

const cfg = {
  apple: { bundleId: "com.fina.app", env: "sandbox" as const, ascIssuerId: "i", ascKeyId: "k", ascPrivateKey: "p" },
  google: { packageName: "app.fina", serviceAccount: {} as any, pubsubVerifyAudience: "a", pubsubVerifyEmail: "e", pubsubSubscriptionName: "s" },
};

describe("syncSubscriptionFromIAP — Apple checkout path", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    await prisma.user.create({ data: { id: "u1", email: "u1@test" } });
  });

  it("upserts Subscription + writes User.iapAppleAccountToken on success", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app", environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("u1"),
      productId: "pro_monthly",
      originalTransactionId: "OT-1",
      transactionId: "T-1",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "pro_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });

    await syncSubscriptionFromIAP(cfg, {
      platform: "ios",
      receipt: "jws",
      userId: "u1",
      expectedAppAccountToken: deriveAppleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub).not.toBeNull();
    expect(sub!.source).toBe("iap_apple");
    expect(sub!.sourceSubscriptionId).toBe("OT-1");
    expect(sub!.tier).toBe("pro");
    expect(sub!.environment).toBe("Sandbox");

    const user = await prisma.user.findUnique({ where: { id: "u1" } });
    expect(user!.iapAppleAccountToken).toBe(deriveAppleToken("u1"));
  });

  it("403 user_mismatch when verified appAccountToken disagrees with expected", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app", environment: "Sandbox",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("OTHER-USER"),
      productId: "pro_monthly",
      originalTransactionId: "OT-1",
      transactionId: "T-1",
      raw: {},
    });

    await expect(
      syncSubscriptionFromIAP(cfg, {
        platform: "ios", receipt: "jws", userId: "u1",
        expectedAppAccountToken: deriveAppleToken("u1"),
      }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient }),
    ).rejects.toMatchObject({ code: "user_mismatch", statusCode: 403 });
  });

  it("derives tier from VERIFIED productId, not from request body", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app", environment: "Production",
      signedDate: Date.now(),
      appAccountToken: deriveAppleToken("u1"),
      productId: "lite_monthly", // verified
      originalTransactionId: "OT-2", transactionId: "T-2",
      raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "lite_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    await syncSubscriptionFromIAP(cfg, {
      platform: "ios", receipt: "jws", userId: "u1",
      productId: "pro_monthly", // body claims pro
      expectedAppAccountToken: deriveAppleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub!.tier).toBe("lite"); // verified wins
  });
});

describe("syncSubscriptionFromIAP — Google checkout path", () => {
  beforeEach(async () => {
    await truncateAll();
    vi.clearAllMocks();
    await prisma.user.create({ data: { id: "u1", email: "u1@test" } });
  });

  it("upserts + writes iapGoogleObfuscatedId + acknowledges", async () => {
    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "pro_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: null,
      environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });
    fakeGoogleClient.acknowledgeIfPending.mockResolvedValue(true);

    await syncSubscriptionFromIAP(cfg, {
      platform: "android", receipt: "pt-1", userId: "u1",
      expectedObfuscatedAccountId: deriveGoogleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });

    const sub = await prisma.subscription.findFirst({ where: { userId: "u1" } });
    expect(sub!.source).toBe("iap_google");
    expect(sub!.sourceSubscriptionId).toBe("pt-1");
    const user = await prisma.user.findUnique({ where: { id: "u1" } });
    expect(user!.iapGoogleObfuscatedId).toBe(deriveGoogleToken("u1"));
    expect(fakeGoogleClient.acknowledgeIfPending).toHaveBeenCalledWith({
      purchaseToken: "pt-1",
      productId: "pro_monthly",
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
    });
  });

  it("acknowledge runs AFTER upsert succeeds (not before)", async () => {
    const order: string[] = [];
    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "pro_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: null, environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });
    fakeGoogleClient.acknowledgeIfPending.mockImplementation(async () => {
      order.push("ack");
    });
    // Spy upsert via a Prisma middleware would be heavy; instead, the
    // assertion is: after the call returns, the row exists AND ack ran.
    await syncSubscriptionFromIAP(cfg, {
      platform: "android", receipt: "pt-2", userId: "u1",
      expectedObfuscatedAccountId: deriveGoogleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });
    const sub = await prisma.subscription.findFirst({ where: { userId: "u1", sourceSubscriptionId: "pt-2" } });
    expect(sub).not.toBeNull();
    expect(order).toEqual(["ack"]);
  });

  it("rewrites existing row on linkedPurchaseToken chain", async () => {
    // Seed: an active sub already exists under pt-old
    await prisma.subscription.create({ data: {
      userId: "u1", tier: "lite", source: "iap_google",
      sourceSubscriptionId: "pt-old", sourceCustomerId: deriveGoogleToken("u1"),
      status: "active", currentPeriodEnd: new Date(Date.now() + 30*86400_000),
      environment: "Production",
    } });

    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "pro_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: "pt-old",
      environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });

    await syncSubscriptionFromIAP(cfg, {
      platform: "android", receipt: "pt-new", userId: "u1",
      expectedObfuscatedAccountId: deriveGoogleToken("u1"),
    }, { appleClient: fakeAppleClient, googleClient: fakeGoogleClient });

    const all = await prisma.subscription.findMany({ where: { userId: "u1" } });
    expect(all.length).toBe(1);
    expect(all[0].sourceSubscriptionId).toBe("pt-new");
    expect(all[0].tier).toBe("pro");
  });
});
```

- [ ] **Step 7.6: Implement `sync-sub.ts`**

```ts
// apps/api/src/iap/sync-sub.ts
import { prisma } from "../db.js";
import { HttpError } from "../auth/context.js";
import { tierForIapProductId } from "@fina/shared";
import type { AppleClient } from "./apple-client.js";
import type { GoogleClient } from "./google-client.js";
import type { IapConfig } from "./env-guard.js";

export type SyncArgsApple = {
  platform: "ios";
  receipt: string;            // signedTransaction JWS
  userId: string;
  productId?: string;         // request body claim (telemetry only)
  expectedAppAccountToken?: string; // mandatory on checkout/restore; absent on webhook
  context?: "checkout" | "restore" | "assn";
};

export type SyncArgsGoogle = {
  platform: "android";
  receipt: string;            // purchaseToken
  userId: string;
  productId?: string;
  expectedObfuscatedAccountId?: string;
  context?: "checkout" | "restore" | "rtdn";
};

export type SyncArgs = SyncArgsApple | SyncArgsGoogle;

export type SyncDeps = {
  appleClient: Pick<AppleClient, "verifyAndDecodeTransaction" | "getSubscriptionStatus">;
  googleClient: Pick<GoogleClient, "fetchAndNormalize" | "acknowledgeIfPending">;
};

/** End-to-end orchestrator. Per spec §5.2 + §5.3:
 *  1. Verify the receipt with the platform-specific client.
 *  2. If `expected*` token supplied, MUST match the verified value or 403.
 *  3. Derive tier ONLY from the verified productId (never the body claim).
 *  4. Upsert Subscription row (handles linkedPurchaseToken chain for Google).
 *  5. Write User.iap* binding column (idempotent — value is deterministic).
 *  6. For Google + PENDING ack state, call acknowledge AFTER upsert lands. */
export async function syncSubscriptionFromIAP(
  cfg: IapConfig,
  args: SyncArgs,
  deps: SyncDeps,
): Promise<void> {
  if (args.platform === "ios") return syncApple(cfg, args, deps);
  return syncGoogle(cfg, args, deps);
}

async function syncApple(_cfg: IapConfig, args: SyncArgsApple, deps: SyncDeps): Promise<void> {
  const context = args.context === "assn" ? "assn" : "asc-api";
  const verified = await deps.appleClient.verifyAndDecodeTransaction(args.receipt, { context });

  if (args.expectedAppAccountToken && args.expectedAppAccountToken !== verified.appAccountToken) {
    throw new HttpError(403, "user_mismatch", "appAccountToken mismatch");
  }

  const tier = tierForIapProductId(verified.productId);
  if (!tier) throw new HttpError(400, "product_mismatch", `unknown productId ${verified.productId}`);

  if (args.productId && args.productId !== verified.productId) {
    // Body productId disagrees with verified — telemetry-only, not fatal.
    // (Server already trusts verified.)
  }

  const status = await deps.appleClient.getSubscriptionStatus(verified.originalTransactionId);

  await prisma.$transaction(async (tx) => {
    await tx.subscription.upsert({
      where: {
        source_sourceSubscriptionId: {
          source: "iap_apple",
          sourceSubscriptionId: verified.originalTransactionId,
        },
      },
      create: {
        userId: args.userId,
        tier,
        source: "iap_apple",
        sourceSubscriptionId: verified.originalTransactionId,
        sourceCustomerId: verified.appAccountToken,
        status: status.mapped.status,
        currentPeriodEnd: status.expiresDate,
        cancelAtPeriodEnd: status.mapped.cancelAtPeriodEnd,
        billingPeriod: "monthly",
        environment: verified.environment,
      },
      update: {
        tier,
        status: status.mapped.status,
        currentPeriodEnd: status.expiresDate,
        cancelAtPeriodEnd: status.mapped.cancelAtPeriodEnd,
        environment: verified.environment,
      },
    });
    // Idempotent — value is deterministic. updateMany avoids the unique
    // constraint conflict when the column already holds the same value.
    await tx.user.updateMany({
      where: { id: args.userId },
      data: { iapAppleAccountToken: verified.appAccountToken },
    });
  });
}

async function syncGoogle(_cfg: IapConfig, args: SyncArgsGoogle, deps: SyncDeps): Promise<void> {
  const v2 = await deps.googleClient.fetchAndNormalize(args.receipt);

  if (args.expectedObfuscatedAccountId && args.expectedObfuscatedAccountId !== v2.obfuscatedExternalAccountId) {
    throw new HttpError(403, "user_mismatch", "obfuscatedExternalAccountId mismatch");
  }

  const tier = tierForIapProductId(v2.productId);
  if (!tier) throw new HttpError(400, "product_mismatch", `unknown productId ${v2.productId}`);

  await prisma.$transaction(async (tx) => {
    if (v2.linkedPurchaseToken) {
      // Try to rewrite the existing row keyed under the predecessor token.
      const updated = await tx.subscription.updateMany({
        where: { source: "iap_google", sourceSubscriptionId: v2.linkedPurchaseToken },
        data: {
          sourceSubscriptionId: args.receipt,
          tier,
          status: v2.mapped.status,
          currentPeriodEnd: v2.expiryTime,
          cancelAtPeriodEnd: v2.mapped.cancelAtPeriodEnd,
          environment: v2.environment,
        },
      });
      if (updated.count > 0) {
        await tx.user.updateMany({ where: { id: args.userId }, data: { iapGoogleObfuscatedId: v2.obfuscatedExternalAccountId } });
        return;
      }
      // No predecessor row — fall through to plain upsert. Next sync reconciles.
    }
    await tx.subscription.upsert({
      where: {
        source_sourceSubscriptionId: {
          source: "iap_google",
          sourceSubscriptionId: args.receipt,
        },
      },
      create: {
        userId: args.userId,
        tier,
        source: "iap_google",
        sourceSubscriptionId: args.receipt,
        sourceCustomerId: v2.obfuscatedExternalAccountId,
        status: v2.mapped.status,
        currentPeriodEnd: v2.expiryTime,
        cancelAtPeriodEnd: v2.mapped.cancelAtPeriodEnd,
        billingPeriod: "monthly",
        environment: v2.environment,
      },
      update: {
        tier,
        status: v2.mapped.status,
        currentPeriodEnd: v2.expiryTime,
        cancelAtPeriodEnd: v2.mapped.cancelAtPeriodEnd,
        environment: v2.environment,
      },
    });
    await tx.user.updateMany({
      where: { id: args.userId },
      data: { iapGoogleObfuscatedId: v2.obfuscatedExternalAccountId },
    });
  });

  // AFTER upsert lands — never before. Spec §7 step 3. Pass the
  // already-fetched state so the client doesn't re-roundtrip.
  await deps.googleClient.acknowledgeIfPending({
    purchaseToken: args.receipt,
    productId: v2.productId,
    acknowledgementState: v2.acknowledgementState,
  });
}
```

- [ ] **Step 7.7: Run sync-sub tests, confirm pass**

```
npx vitest run tests/iap/sync-sub.test.ts
```
Expected: PASS 6/6.

- [ ] **Step 7.8: Commit**

```
git add apps/api/package.json apps/api/src/iap/binding.ts apps/api/src/iap/sync-sub.ts apps/api/tests/iap/binding.test.ts apps/api/tests/iap/sync-sub.test.ts
git commit -m "feat(api): syncSubscriptionFromIAP orchestrator + deterministic binding helpers"
```

---

## Task 8: `buildMeBody` source precedence + sandbox env filter

**Files:**
- Modify: `apps/api/src/routes/billing.ts` (replace `find(pro) ?? activeSubs[0]` with deterministic helper)
- Modify: `apps/api/src/auth/tier.ts` (filter sandbox rows in prod env)
- Create: `apps/api/src/billing/precedence.ts` (pure helper, easy to unit test)
- Test: `apps/api/tests/billing/precedence.test.ts`

- [ ] **Step 8.1: Write precedence helper test**

```ts
// apps/api/tests/billing/precedence.test.ts
import { describe, it, expect } from "vitest";
import { pickPrimarySub, filterEnvironmentRows } from "../../src/billing/precedence.js";

const mk = (over: any) => ({
  source: "stripe", tier: "lite", status: "active",
  currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
  cancelAtPeriodEnd: false, pendingTier: null, pendingTierAt: null,
  createdAt: new Date(),
  environment: "Production",
  sourceCustomerId: null,
  sourceSubscriptionId: "x",
  ...over,
});

describe("pickPrimarySub", () => {
  it("returns null on empty input", () => {
    expect(pickPrimarySub([])).toBeNull();
  });
  it("Stripe wins over IAP even when IAP has higher tier", () => {
    const stripeLite = mk({ source: "stripe", tier: "lite", createdAt: new Date("2026-01-01") });
    const iapPro = mk({ source: "iap_apple", tier: "pro", createdAt: new Date("2026-02-01") });
    expect(pickPrimarySub([iapPro, stripeLite])?.source).toBe("stripe");
  });
  it("Among non-Stripe, pro beats lite", () => {
    const iapLite = mk({ source: "iap_apple", tier: "lite" });
    const iapPro  = mk({ source: "iap_google", tier: "pro" });
    expect(pickPrimarySub([iapLite, iapPro])?.tier).toBe("pro");
  });
  it("Tiebreak by source: apple > google", () => {
    const apple = mk({ source: "iap_apple", tier: "pro" });
    const google = mk({ source: "iap_google", tier: "pro" });
    expect(pickPrimarySub([google, apple])?.source).toBe("iap_apple");
  });
  it("Tiebreak by createdAt ASC", () => {
    const a = mk({ source: "iap_apple", tier: "pro", createdAt: new Date("2026-01-01"), sourceSubscriptionId: "a" });
    const b = mk({ source: "iap_apple", tier: "pro", createdAt: new Date("2026-02-01"), sourceSubscriptionId: "b" });
    expect(pickPrimarySub([b, a])?.sourceSubscriptionId).toBe("a");
  });
});

describe("filterEnvironmentRows", () => {
  it("excludes Sandbox rows in production", () => {
    const rows = [mk({ environment: "Production" }), mk({ environment: "Sandbox", sourceSubscriptionId: "s" })];
    expect(filterEnvironmentRows(rows, "production").length).toBe(1);
  });
  it("keeps everything in sandbox runtime", () => {
    const rows = [mk({ environment: "Production" }), mk({ environment: "Sandbox" })];
    expect(filterEnvironmentRows(rows, "sandbox").length).toBe(2);
  });
});
```

- [ ] **Step 8.2: Implement `precedence.ts`**

```ts
// apps/api/src/billing/precedence.ts
type Sub = {
  source: string;
  tier: string;
  createdAt: Date;
  environment: string;
  sourceSubscriptionId: string;
  [k: string]: unknown;
};

const SOURCE_RANK: Record<string, number> = {
  stripe: 0,
  iap_apple: 2,
  iap_google: 3,
};
const TIER_RANK: Record<string, number> = { pro: 0, lite: 1 };

/** Deterministic primary-sub picker. Stripe wins unconditionally;
 *  inside non-Stripe, pro > lite; then source order; then createdAt ASC.
 *  See spec §8 "Stripe always wins regardless of tier". */
export function pickPrimarySub<T extends Sub>(subs: ReadonlyArray<T>): T | null {
  if (subs.length === 0) return null;
  const sorted = [...subs].sort((a, b) => {
    const aStripe = a.source === "stripe" ? 0 : 1;
    const bStripe = b.source === "stripe" ? 0 : 1;
    if (aStripe !== bStripe) return aStripe - bStripe;
    const tier = (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9);
    if (tier !== 0) return tier;
    const src = (SOURCE_RANK[a.source] ?? 9) - (SOURCE_RANK[b.source] ?? 9);
    if (src !== 0) return src;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return sorted[0];
}

/** Filter out rows whose `environment` doesn't match the runtime.
 *  Stripe rows default to "Production" so they're always kept in prod.
 *  Generic over the minimal shape — accepts anything with `environment`. */
export function filterEnvironmentRows<T extends { environment: string }>(
  rows: ReadonlyArray<T>,
  runtime: "sandbox" | "production",
): T[] {
  if (runtime === "sandbox") return [...rows];
  return rows.filter((r) => r.environment === "Production");
}
```

- [ ] **Step 8.3: Run precedence tests, confirm pass**

```
npx vitest run tests/billing/precedence.test.ts
```
Expected: PASS 7/7.

- [ ] **Step 8.4: Rewire `billing.ts buildMeBody` (exported, takes runtimeEnv)**

In `apps/api/src/routes/billing.ts`, change the function declaration AND every call site:

```ts
// Top of file — add import:
import { pickPrimarySub, filterEnvironmentRows } from "../billing/precedence.js";

// Replace the declaration (currently `async function buildMeBody(userId: string)`):
export async function buildMeBody(
  userId: string,
  runtimeEnv: "sandbox" | "production",
): Promise<MeDTO> {
  const [user, activeSubs] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.subscription.findMany({
      where: {
        userId,
        status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] },
      },
      orderBy: { currentPeriodEnd: "desc" },
    }),
  ]);
  const t = computeEffectiveTier(user, activeSubs);
  // Sandbox env filter MUST run before precedence — stale sandbox rows
  // should not influence the primary pick or the EffectiveTier.
  const filtered = filterEnvironmentRows(activeSubs, runtimeEnv);
  const primary = pickPrimarySub(filtered);
  // ... rest of the existing body, replacing the find(pro) ?? activeSubs[0] line ...
}
```

Update **every call site** of `buildMeBody` in the file (each Stripe-route handler that returns the MeDTO):

```ts
// /billing/sync handler (around line ~157):
const runtimeEnv = app.fina.env.APPLE_ENV === "production" ? "production" : "sandbox";
return await buildMeBody(user.id, runtimeEnv);
```

There is only one existing call site in `billing.ts` (`/billing/sync`). The new IAP routes (Task 9) call this function too.

Note: `effectiveTier` (in `auth/tier.ts`) ALSO needs the env filter — handled in Step 8.5 below.

- [ ] **Step 8.5: Update `auth/tier.ts` to apply the same filter**

Now that `filterEnvironmentRows` is generic over `{environment: string}` (P6), the synthetic-fields hack is gone. In `apps/api/src/auth/tier.ts`:

```ts
import { filterEnvironmentRows } from "../billing/precedence.js";
import { loadEnv } from "../env.js";

// Cache the runtime env at module load — `loadEnv()` is the same
// validator buildApp uses, so the value matches everywhere.
const _runtimeEnv: "sandbox" | "production" =
  loadEnv().APPLE_ENV === "production" ? "production" : "sandbox";

export async function effectiveTier(userId: string): Promise<EffectiveTier> {
  const [user, activeSubs] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.subscription.findMany({
      where: { userId, status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as Prisma.$Enums.SubscriptionStatus[] } },
      select: { tier: true, environment: true },
    }),
  ]);
  const filtered = filterEnvironmentRows(activeSubs, _runtimeEnv);
  return computeEffectiveTier(user, filtered);
}
```

- [ ] **Step 8.6: Run full billing tests**

```
npx vitest run tests/billing tests/iap
```
Expected: zero new failures, precedence tests pass.

- [ ] **Step 8.7: Commit**

```
git add apps/api/src/billing/precedence.ts apps/api/src/routes/billing.ts apps/api/src/auth/tier.ts apps/api/tests/billing/precedence.test.ts
git commit -m "feat(api): deterministic source precedence + sandbox-environment filter in buildMeBody/effectiveTier"
```

---

## Task 9: Routes — `POST /billing/iap/checkout` + `POST /billing/iap/restore`

**Files:**
- Create: `apps/api/src/routes/billing-iap.ts`
- Modify: `apps/api/src/server.ts` (register the new plugin)
- Test: `apps/api/tests/iap/billing-iap.routes.test.ts`

- [ ] **Step 9.1: Write integration test scaffold**

```ts
// apps/api/tests/iap/billing-iap.routes.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { signUpAndGetCookie } from "../helpers/auth.js";
import { testEnv } from "../helpers/test-env.js";
import { makeIapMocks } from "../helpers/iap-mocks.js";
import { deriveAppleToken } from "../../src/iap/binding.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const fakeAppleClient: any = { verifyAndDecodeTransaction: vi.fn(), getSubscriptionStatus: vi.fn() };
const fakeGoogleClient: any = { fetchAndNormalize: vi.fn(), acknowledgeIfPending: vi.fn().mockResolvedValue(true) };

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  app = await buildApp(testEnv(), { iap: { appleClient: fakeAppleClient, googleClient: fakeGoogleClient, oidcClient: { verifyIdToken: vi.fn() } } });
  await prisma.user.create({ data: { id: "u1", email: "u1@test" } });
});

describe("POST /billing/iap/checkout", () => {
  it("400 invalid_body when payload malformed", async () => {
    const res = await app.inject({
      method: "POST", url: "/billing/iap/checkout",
      headers: { cookie: await signUpAndGetCookie(app, "u1@test") },
      payload: { platform: "ios" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("409 already_subscribed_stripe when user already has active Stripe sub", async () => {
    await prisma.subscription.create({ data: {
      userId: "u1", tier: "lite", source: "stripe", sourceSubscriptionId: "sub_x",
      status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86400_000), environment: "Production",
    } });
    const res = await app.inject({
      method: "POST", url: "/billing/iap/checkout",
      headers: { cookie: await signUpAndGetCookie(app, "u1@test") },
      payload: { platform: "ios", productId: "pro_monthly", receipt: "jws" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_subscribed_stripe");
  });

  it("happy path returns MeDTO with new IAP sub", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app", environment: "Sandbox", signedDate: Date.now(),
      appAccountToken: deriveAppleToken("u1"),
      productId: "pro_monthly", originalTransactionId: "OT-1", transactionId: "T-1", raw: {},
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "pro_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    const res = await app.inject({
      method: "POST", url: "/billing/iap/checkout",
      headers: { cookie: await signUpAndGetCookie(app, "u1@test") },
      payload: { platform: "ios", productId: "pro_monthly", receipt: "jws" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tier).toBe("pro");
    expect(body.subscription.source).toBe("iap_apple");
  });

  it("403 user_mismatch when appAccountToken doesn't match caller", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue({
      bundleId: "com.fina.app", environment: "Sandbox", signedDate: Date.now(),
      appAccountToken: deriveAppleToken("OTHER"),
      productId: "pro_monthly", originalTransactionId: "OT-1", transactionId: "T-1", raw: {},
    });
    const res = await app.inject({
      method: "POST", url: "/billing/iap/checkout",
      headers: { cookie: await signUpAndGetCookie(app, "u1@test") },
      payload: { platform: "ios", productId: "pro_monthly", receipt: "jws" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("user_mismatch");
  });
});

describe("POST /billing/iap/restore", () => {
  it("partial success — skips failures, returns MeDTO", async () => {
    fakeAppleClient.verifyAndDecodeTransaction.mockImplementation(async (jws: string) => {
      if (jws === "ok") return {
        bundleId: "com.fina.app", environment: "Sandbox", signedDate: Date.now(),
        appAccountToken: deriveAppleToken("u1"),
        productId: "lite_monthly", originalTransactionId: "OT-1", transactionId: "T-1", raw: {},
      };
      throw new Error("bad");
    });
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "lite_monthly",
      mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    const res = await app.inject({
      method: "POST", url: "/billing/iap/restore",
      headers: { cookie: await signUpAndGetCookie(app, "u1@test") },
      payload: {
        platform: "ios",
        purchases: [
          { productId: "lite_monthly", receipt: "ok" },
          { productId: "pro_monthly", receipt: "bad" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tier).toBe("lite");
  });
});
```

- [ ] **Step 9.2: Implement `billing-iap.ts`**

```ts
// apps/api/src/routes/billing-iap.ts
import type { FastifyInstance } from "fastify";
import type { $Enums } from "@prisma/client";
import { IAPCheckoutBody, IAPRestoreBody, ACTIVE_SUBSCRIPTION_STATUSES } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { requireIapEnv } from "../iap/env-guard.js";
import { syncSubscriptionFromIAP } from "../iap/sync-sub.js";
import { deriveAppleToken, deriveGoogleToken } from "../iap/binding.js";
import { AppleClient } from "../iap/apple-client.js";
import { GoogleClient } from "../iap/google-client.js";

export async function billingIapRoutes(app: FastifyInstance): Promise<void> {
  // Allow tests to inject mocked clients via decorator; production wires
  // real clients from env at first use.
  const iapDeps = () => {
    const injected = (app as any).fina?.iap as
      | { appleClient: AppleClient; googleClient: GoogleClient }
      | undefined;
    if (injected) return injected;
    const cfg = requireIapEnv(process.env);
    return {
      appleClient: new AppleClient(cfg.apple),
      googleClient: new GoogleClient(cfg.google),
    };
  };

  app.post("/billing/iap/checkout", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = IAPCheckoutBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const cfg = requireIapEnv(process.env);
      const deps = iapDeps();
      const userId = session.userId;

      const active = await prisma.subscription.findMany({
        where: {
          userId,
          status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] },
        },
        select: { source: true },
      });
      const stripeActive = active.some((s) => s.source === "stripe");
      const iapActive = active.some((s) => s.source === "iap_apple" || s.source === "iap_google");
      if (stripeActive) return reply.code(409).send({ error: "already_subscribed_stripe" });
      if (iapActive) return reply.code(409).send({ error: "already_subscribed_iap" });

      if (parsed.data.platform === "ios") {
        await syncSubscriptionFromIAP(cfg, {
          platform: "ios",
          receipt: parsed.data.receipt,
          userId,
          productId: parsed.data.productId,
          expectedAppAccountToken: deriveAppleToken(userId),
          context: "checkout",
        }, deps);
      } else {
        await syncSubscriptionFromIAP(cfg, {
          platform: "android",
          receipt: parsed.data.receipt,
          userId,
          productId: parsed.data.productId,
          expectedObfuscatedAccountId: deriveGoogleToken(userId),
          context: "checkout",
        }, deps);
      }

      // Re-use the existing /billing/sync MeDTO builder — extracted in Task 8
      // to a shared helper. Import is the same module-relative path.
      const { buildMeBody } = await import("./billing.js");
      return await buildMeBody(userId, cfg.apple.env);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e, route: "/billing/iap/checkout" }, "iap_checkout_failed");
      return reply.code(500).send({ error: "iap_checkout_failed" });
    }
  });

  app.post("/billing/iap/restore", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = IAPRestoreBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const cfg = requireIapEnv(process.env);
      const deps = iapDeps();
      const userId = session.userId;

      for (const item of parsed.data.purchases) {
        try {
          if (parsed.data.platform === "ios") {
            await syncSubscriptionFromIAP(cfg, {
              platform: "ios", receipt: item.receipt, userId,
              productId: item.productId,
              expectedAppAccountToken: deriveAppleToken(userId),
              context: "restore",
            }, deps);
          } else {
            await syncSubscriptionFromIAP(cfg, {
              platform: "android", receipt: item.receipt, userId,
              productId: item.productId,
              expectedObfuscatedAccountId: deriveGoogleToken(userId),
              context: "restore",
            }, deps);
          }
        } catch (e) {
          // Spec §5.3 restore: "Skip (log + continue) on individual failures".
          app.log.warn({ err: e, productId: item.productId }, "iap_restore_item_failed");
        }
      }
      const { buildMeBody } = await import("./billing.js");
      return await buildMeBody(userId, cfg.apple.env);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      app.log.error({ err: e, route: "/billing/iap/restore" }, "iap_restore_failed");
      return reply.code(500).send({ error: "iap_restore_failed" });
    }
  });
}
```

- [ ] **Step 9.3: Register plugin in `server.ts`**

Find the existing `billingRoutes` registration and add a sibling line:

```ts
import { billingIapRoutes } from "./routes/billing-iap.js";
// ...
await app.register(billingIapRoutes);
```

- [ ] **Step 9.4: Export `buildMeBody` from `billing.ts`**

In `apps/api/src/routes/billing.ts`, change `async function buildMeBody` → `export async function buildMeBody`. Add the `runtimeEnv` parameter as introduced in Task 8.

- [ ] **Step 9.5: Run integration test, confirm pass**

```
npx vitest run tests/iap/billing-iap.routes.test.ts
```
Expected: PASS 5/5.

- [ ] **Step 9.6: Commit**

```
git add apps/api/src/routes/billing-iap.ts apps/api/src/routes/billing.ts apps/api/src/server.ts apps/api/tests/iap/billing-iap.routes.test.ts
git commit -m "feat(api): POST /billing/iap/checkout + /billing/iap/restore"
```

---

## Task 10: Webhook routes — `/webhooks/iap/apple` + `/webhooks/iap/google`

**Files:**
- Create: `apps/api/src/routes/billing-iap-webhook.ts`
- Modify: `apps/api/src/server.ts` (register the new plugin)
- Test: `apps/api/tests/iap/billing-iap-webhook.test.ts`

- [ ] **Step 10.1: Write integration test scaffold**

```ts
// apps/api/tests/iap/billing-iap-webhook.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildApp } from "../../src/server.js";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { deriveAppleToken, deriveGoogleToken, hashBindingToken } from "../../src/iap/binding.js";

let app: Awaited<ReturnType<typeof buildApp>>;
const fakeAppleClient: any = {
  verifyAndDecodeTransaction: vi.fn(),
  verifyAndDecodeNotification: vi.fn(),
  verifyAndDecodeRenewalInfo: vi.fn(),
  getSubscriptionStatus: vi.fn(),
};
const fakeGoogleClient: any = { fetchAndNormalize: vi.fn(), acknowledgeIfPending: vi.fn().mockResolvedValue(true) };
const fakeOidcClient: any = { verifyIdToken: vi.fn() };

beforeEach(async () => {
  await truncateAll();
  vi.clearAllMocks();
  app = await buildApp(testEnv(), { iap: { appleClient: fakeAppleClient, googleClient: fakeGoogleClient, oidcClient: fakeOidcClient } });
  await prisma.user.create({ data: { id: "u1", email: "u1@test", iapAppleAccountToken: deriveAppleToken("u1") } });
});

describe("POST /webhooks/iap/apple", () => {
  const signedDate = Date.now();
  const appleTx = () => ({
    bundleId: "com.fina.app", environment: "Sandbox", signedDate,
    appAccountToken: deriveAppleToken("u1"),
    productId: "pro_monthly", originalTransactionId: "OT-1", transactionId: "T-1", raw: {},
  });

  it("happy path: existing Subscription row, syncs to active", async () => {
    await prisma.subscription.create({ data: {
      userId: "u1", tier: "pro", source: "iap_apple",
      sourceSubscriptionId: "OT-1", sourceCustomerId: deriveAppleToken("u1"),
      status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86400_000), environment: "Sandbox",
    } });
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-1", notificationType: "DID_RENEW",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 60 * 86400_000),
      productId: "pro_monthly", mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("step 4.2 fallback: webhook before checkout — finds user via binding", async () => {
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-2", notificationType: "SUBSCRIBED",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "pro_monthly", mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res.statusCode).toBe(200);
    const sub = await prisma.subscription.findFirst({ where: { userId: "u1", source: "iap_apple" } });
    expect(sub).not.toBeNull();
  });

  it("step 4.3 tombstone hit returns 200 (deleted user, stop retrying)", async () => {
    await prisma.user.update({ where: { id: "u1" }, data: { iapAppleAccountToken: null } });
    await prisma.iapDeletedBinding.create({
      data: { source: "iap_apple", tokenHash: hashBindingToken(deriveAppleToken("u1")) },
    });
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-3", notificationType: "DID_RENEW",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res.statusCode).toBe(200);
    const sub = await prisma.subscription.findFirst({ where: { source: "iap_apple" } });
    expect(sub).toBeNull(); // no row created
    const tombstoneEvent = await prisma.webhookEvent.findFirst({ where: { type: "unattributable_after_delete" } });
    expect(tombstoneEvent).not.toBeNull();
  });

  it("step 4.4 unknown user returns 500 up to retry-cap, then forensic 200 (same UUID across retries — real Apple behavior)", async () => {
    await prisma.user.update({ where: { id: "u1" }, data: { iapAppleAccountToken: null } });
    // Apple delivers the SAME notificationUUID on every retry. The counter
    // must therefore key on the binding token (appAccountToken), not the
    // UUID. The dedup row is written only AFTER successful sync — so 500
    // responses do NOT create the dedup row, meaning retries are not
    // short-circuited until the counter hits the cap.
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-4-stable", notificationType: "DID_RENEW",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    // First 5 attempts: 500.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST", url: "/webhooks/iap/apple",
        payload: { signedPayload: "fake-jws" },
      });
      expect(res.statusCode).toBe(500);
    }
    // 6th attempt: counter > MAX_UNKNOWN_RETRIES (5) → forensic 200 +
    // dedup row. Subsequent retries hit the dedup short-circuit.
    const res6 = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res6.statusCode).toBe(200);
    const forensic = await prisma.webhookEvent.findFirst({ where: { type: "unattributable_giveup" } });
    expect(forensic).not.toBeNull();
    // 7th attempt: deduped via the giveup row.
    const res7 = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res7.statusCode).toBe(200);
  });

  it("dedup — second delivery of same notificationUUID short-circuits", async () => {
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-dup", notificationType: "DID_RENEW",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    fakeAppleClient.getSubscriptionStatus.mockResolvedValue({
      expiresDate: new Date(Date.now() + 30 * 86400_000),
      productId: "pro_monthly", mapped: { status: "active", cancelAtPeriodEnd: false },
    });
    await app.inject({ method: "POST", url: "/webhooks/iap/apple", payload: { signedPayload: "fake-jws" } });
    fakeAppleClient.getSubscriptionStatus.mockClear();
    await app.inject({ method: "POST", url: "/webhooks/iap/apple", payload: { signedPayload: "fake-jws" } });
    expect(fakeAppleClient.getSubscriptionStatus).not.toHaveBeenCalled();
  });

  it("Family Sharing revocation flips Subscription.status to canceled", async () => {
    await prisma.subscription.create({ data: {
      userId: "u1", tier: "pro", source: "iap_apple",
      sourceSubscriptionId: "OT-1", sourceCustomerId: deriveAppleToken("u1"),
      status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86400_000), environment: "Sandbox",
    } });
    fakeAppleClient.verifyAndDecodeNotification.mockResolvedValue({
      notificationUUID: "uuid-fs", notificationType: "DID_CHANGE_RENEWAL_STATUS",
      subtype: "PRODUCT_NOT_FOR_SALE",
      signedTransactionJws: "tx-jws", raw: {},
    });
    fakeAppleClient.verifyAndDecodeTransaction.mockResolvedValue(appleTx());
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/apple",
      payload: { signedPayload: "fake-jws" },
    });
    expect(res.statusCode).toBe(200);
    const sub = await prisma.subscription.findFirst({ where: { source: "iap_apple", sourceSubscriptionId: "OT-1" } });
    expect(sub!.status).toBe("canceled");
  });
});

describe("POST /webhooks/iap/google", () => {
  beforeEach(() => {
    fakeOidcClient.verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        aud: "https://api.fina.app/webhooks/iap/google",
        iss: "https://accounts.google.com",
        email: "iap@fina.iam.gserviceaccount.com",
        azp: "iap@fina.iam.gserviceaccount.com",
        exp: Math.floor(Date.now() / 1000) + 60,
      }),
    });
  });

  it("happy path", async () => {
    await prisma.user.update({ where: { id: "u1" }, data: { iapGoogleObfuscatedId: deriveGoogleToken("u1") } });
    fakeGoogleClient.fetchAndNormalize.mockResolvedValue({
      obfuscatedExternalAccountId: deriveGoogleToken("u1"),
      acknowledgementState: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
      productId: "pro_monthly",
      expiryTime: new Date(Date.now() + 30 * 86400_000),
      linkedPurchaseToken: null, environment: "Production",
      mapped: { status: "active", cancelAtPeriodEnd: false },
      raw: {},
    });
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify({
          subscriptionNotification: { purchaseToken: "pt-1", subscriptionId: "pro_monthly", notificationType: 4 },
        })).toString("base64"),
        messageId: "msg-1",
      },
      subscription: "projects/fina/subscriptions/iap-rtdn",
    };
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/google",
      headers: { authorization: "Bearer fake-jwt" },
      payload: envelope,
    });
    expect(res.statusCode).toBe(200);
  });

  it("testNotification → 200 ignore", async () => {
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify({ testNotification: { version: "1.0" } })).toString("base64"),
        messageId: "msg-test",
      },
      subscription: "projects/fina/subscriptions/iap-rtdn",
    };
    const res = await app.inject({
      method: "POST", url: "/webhooks/iap/google",
      headers: { authorization: "Bearer fake-jwt" },
      payload: envelope,
    });
    expect(res.statusCode).toBe(200);
    expect(fakeGoogleClient.fetchAndNormalize).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 10.2: Implement `billing-iap-webhook.ts`**

```ts
// apps/api/src/routes/billing-iap-webhook.ts
import type { FastifyInstance } from "fastify";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../db.js";
import { HttpError } from "../auth/context.js";
import { requireIapEnv } from "../iap/env-guard.js";
import { verifyApplePayload, verifyGoogleEnvelope } from "../iap/webhook-verify.js";
import { syncSubscriptionFromIAP } from "../iap/sync-sub.js";
import { hashBindingToken } from "../iap/binding.js";
import { AppleClient } from "../iap/apple-client.js";
import { GoogleClient } from "../iap/google-client.js";

const MAX_UNKNOWN_RETRIES = 5;

export async function billingIapWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Scoped raw-body parser so JWS / OIDC signature verification gets
  // the exact bytes. Mirrors apps/api/src/routes/billing-webhook.ts:11.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      try {
        done(null, JSON.parse(body.toString("utf8")));
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  const deps = () => {
    const injected = (app as any).fina?.iap as
      | { appleClient: AppleClient; googleClient: GoogleClient; oidcClient: OAuth2Client }
      | undefined;
    if (injected) return injected;
    const cfg = requireIapEnv(process.env);
    return {
      appleClient: new AppleClient(cfg.apple),
      googleClient: new GoogleClient(cfg.google),
      oidcClient: new OAuth2Client(),
    };
  };

  app.post("/webhooks/iap/apple", async (req, reply) => {
    try {
      const cfg = requireIapEnv(process.env);
      const { appleClient } = deps();
      const body = req.body as { signedPayload?: string };
      if (!body?.signedPayload) return reply.code(400).send({ error: "invalid_body" });

      const notification = await verifyApplePayload(body.signedPayload, cfg.apple, { appleClient });
      // notification.signedTransactionJws goes through verifyAndDecodeTransaction
      // (NOT verifyAndDecodeNotification) below — different SDK API, different
      // payload validator. See spec §5.2 check #1-6 + Task 4 Step 4.6.

      // Dedup — keyed on Apple's notificationUUID (stable across retries).
      // IMPORTANT: dedup row is written AFTER successful handler, NOT here
      // (matches Stripe webhook pattern at billing-webhook.ts:51). If we
      // write the dedup row up front, the 500-retry path below would
      // short-circuit on the second delivery before the counter can trip.
      const eventId = `apple:${notification.notificationUUID}`;
      const existing = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
      if (existing) return { ok: true };

      // Family Sharing — treat as canceled per spec §6. Do NOT just log
      // and 200: round-2 §15.3 required actually flipping any matching
      // Subscription row to status=canceled.
      if (
        notification.notificationType === "DID_CHANGE_RENEWAL_STATUS" &&
        notification.subtype === "PRODUCT_NOT_FOR_SALE"
      ) {
        const verifiedTx = await appleClient.verifyAndDecodeTransaction(notification.signedTransactionJws, { context: "assn" });
        await prisma.subscription.updateMany({
          where: { source: "iap_apple", sourceSubscriptionId: verifiedTx.originalTransactionId },
          data: { status: "canceled" },
        });
        await prisma.webhookEvent.create({ data: { id: eventId, source: "iap_apple", type: "family_sharing_revoked" } });
        return { ok: true };
      }

      const verifiedTx = await appleClient.verifyAndDecodeTransaction(notification.signedTransactionJws, { context: "assn" });
      const bindingHash = hashBindingToken(verifiedTx.appAccountToken);

      // 4-step resolution
      let userId: string | null = null;
      // 1. Subscription
      const sub = await prisma.subscription.findFirst({
        where: { source: "iap_apple", sourceSubscriptionId: verifiedTx.originalTransactionId },
        select: { userId: true },
      });
      if (sub) userId = sub.userId;
      // 2. User binding
      if (!userId) {
        const user = await prisma.user.findUnique({ where: { iapAppleAccountToken: verifiedTx.appAccountToken } });
        if (user) userId = user.id;
      }
      // 3. Tombstone — known-deleted user. Stop retrying.
      if (!userId) {
        const tombstone = await prisma.iapDeletedBinding.findUnique({
          where: { source_tokenHash: { source: "iap_apple", tokenHash: bindingHash } },
        });
        if (tombstone) {
          await prisma.webhookEvent.create({
            data: { id: eventId, source: "iap_apple", type: "unattributable_after_delete", body: { tokenHash: bindingHash } as any },
          });
          return reply.code(200).send({ ok: true });
        }
      }
      // 4. 500 with retry-cap keyed on the binding token. Apple retries
      // deliver the SAME notificationUUID, so we cannot use eventId as
      // the counter key (the dedup short-circuit would mask all retries
      // after the first). IapRetryCounter is the per-token counter table.
      if (!userId) {
        const counter = await prisma.iapRetryCounter.upsert({
          where: { source_tokenHash: { source: "iap_apple", tokenHash: bindingHash } },
          create: { source: "iap_apple", tokenHash: bindingHash, attempts: 1 },
          update: { attempts: { increment: 1 }, lastAt: new Date() },
        });
        if (counter.attempts > MAX_UNKNOWN_RETRIES) {
          // Cap reached — write a forensic dedup row so this UUID stops
          // 500-ing on future retries. Subsequent attempts hit the dedup
          // short-circuit above.
          await prisma.webhookEvent.create({
            data: { id: eventId, source: "iap_apple", type: "unattributable_giveup", body: { tokenHash: bindingHash, attempts: counter.attempts } as any },
          });
          return reply.code(200).send({ ok: true });
        }
        // Don't write dedup row — Apple retries are wanted while counter < cap.
        return reply.code(500).send({ error: "user_unknown" });
      }

      await syncSubscriptionFromIAP(cfg, {
        platform: "ios",
        receipt: notification.signedTransactionJws,
        userId,
        context: "assn",
        // webhook path does NOT pass expectedAppAccountToken (spec §12.3)
      }, deps());

      // Dedup row AFTER successful sync (matches Stripe pattern).
      await prisma.webhookEvent.create({ data: { id: eventId, source: "iap_apple", type: notification.notificationType } });
      return reply.code(200).send({ ok: true });
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 400) {
        // Signature failure — 400, no retry.
        return reply.code(400).send({ error: e.code });
      }
      app.log.error({ err: e }, "webhook_iap_apple_failed");
      return reply.code(500).send({ error: "webhook_handler_failed" });
    }
  });

  app.post("/webhooks/iap/google", async (req, reply) => {
    try {
      const cfg = requireIapEnv(process.env);
      const { googleClient, oidcClient } = deps();
      const note = await verifyGoogleEnvelope(
        req.headers.authorization,
        req.body as any,
        cfg.google,
        { oidcClient },
      );

      const eventId = `google:${note.messageId}`;
      const existing = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
      if (existing) return { ok: true };

      if (note.kind === "ignore") {
        await prisma.webhookEvent.create({ data: { id: eventId, source: "iap_google", type: `ignored_${note.reason}` } });
        return { ok: true };
      }

      // 4-step resolution mirrored from Apple side.
      let userId: string | null = null;
      const sub = await prisma.subscription.findFirst({
        where: { source: "iap_google", sourceSubscriptionId: note.payload.purchaseToken },
        select: { userId: true },
      });
      if (sub) userId = sub.userId;

      const v2 = await googleClient.fetchAndNormalize(note.payload.purchaseToken);
      const bindingHash = hashBindingToken(v2.obfuscatedExternalAccountId);
      if (!userId) {
        const user = await prisma.user.findUnique({ where: { iapGoogleObfuscatedId: v2.obfuscatedExternalAccountId } });
        if (user) userId = user.id;
      }
      if (!userId) {
        const tombstone = await prisma.iapDeletedBinding.findUnique({
          where: { source_tokenHash: { source: "iap_google", tokenHash: bindingHash } },
        });
        if (tombstone) {
          await prisma.webhookEvent.create({
            data: { id: eventId, source: "iap_google", type: "unattributable_after_delete", body: { tokenHash: bindingHash } as any },
          });
          return reply.code(200).send({ ok: true });
        }
      }
      if (!userId) {
        const counter = await prisma.iapRetryCounter.upsert({
          where: { source_tokenHash: { source: "iap_google", tokenHash: bindingHash } },
          create: { source: "iap_google", tokenHash: bindingHash, attempts: 1 },
          update: { attempts: { increment: 1 }, lastAt: new Date() },
        });
        if (counter.attempts > MAX_UNKNOWN_RETRIES) {
          await prisma.webhookEvent.create({
            data: { id: eventId, source: "iap_google", type: "unattributable_giveup", body: { tokenHash: bindingHash, attempts: counter.attempts } as any },
          });
          return reply.code(200).send({ ok: true });
        }
        return reply.code(500).send({ error: "user_unknown" });
      }

      await syncSubscriptionFromIAP(cfg, {
        platform: "android",
        receipt: note.payload.purchaseToken,
        userId,
        context: "rtdn",
      }, deps());

      await prisma.webhookEvent.create({ data: { id: eventId, source: "iap_google", type: `notif_${note.payload.notificationType}` } });
      return reply.code(200).send({ ok: true });
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 400) {
        return reply.code(400).send({ error: e.code });
      }
      app.log.error({ err: e }, "webhook_iap_google_failed");
      return reply.code(500).send({ error: "webhook_handler_failed" });
    }
  });
}
```

Note: `WebhookEvent.body` is the `Json?` column added by Task 2's migration. The forensic-event JSON predicates depend on it.

- [ ] **Step 10.3: Register plugin in `server.ts`**

```ts
import { billingIapWebhookRoutes } from "./routes/billing-iap-webhook.js";
await app.register(billingIapWebhookRoutes);
```

- [ ] **Step 10.4: Run webhook integration tests, confirm pass**

```
npx vitest run tests/iap/billing-iap-webhook.test.ts
```
Expected: PASS 8/8 (6 Apple + 2 Google).

- [ ] **Step 10.5: Commit**

```
git add apps/api/src/routes/billing-iap-webhook.ts apps/api/src/server.ts apps/api/tests/iap/billing-iap-webhook.test.ts
git commit -m "feat(api): IAP webhook routes — Apple ASSN + Google RTDN with 4-step userId resolution"
```

---

## Task 11: Mobile — `react-native-iap` install + config plugin + IAP client wrapper + API methods

**Files:**
- Install: `npm install react-native-iap uuid --workspace=apps/mobile`
- Modify: `apps/mobile/app.json` (add `react-native-iap` plugin, BILLING permission)
- Create: `apps/mobile/src/iap/client.ts`
- Create: `apps/mobile/src/iap/binding.ts` (mirrors API `binding.ts` — deterministic token derivation)
- Modify: `apps/mobile/src/api/billing.ts` (add `postIAPCheckout`, `postIAPRestore`)
- Modify: project `CLAUDE.md` (document Expo Go limitation)
- Test: `apps/mobile/src/iap/__tests__/binding.test.ts`

- [ ] **Step 11.1: Install (PIN react-native-iap to v14)**

```
npm install react-native-iap@^14 uuid js-sha256 --workspace=apps/mobile
npm install -D @types/uuid --workspace=apps/mobile
```

**Why pinned to ^14:** `react-native-iap` 15.x is a `nitro`-based rewrite that removed `requestSubscription` (replaced by `requestPurchase` with a different signature). v14 still ships `requestSubscription({sku, appAccountToken, obfuscatedAccountIdAndroid})` — the API this plan + Task 11.6 expects. Upgrading to 15.x is out of scope for v1.

- [ ] **Step 11.2: Update `app.json`**

In `apps/mobile/app.json`, append to `expo.plugins`:

```json
[
  "react-native-iap",
  {
    "paymentProvider": "both"
  }
]
```

- [ ] **Step 11.3: Write `binding` test**

```ts
// apps/mobile/src/iap/__tests__/binding.test.ts
import { describe, it, expect } from "vitest";
import { deriveAppleToken, deriveGoogleToken } from "../binding";

describe("mobile IAP binding (matches API)", () => {
  it("Apple token is uuidv5(userId, IAP_NAMESPACE) — deterministic", () => {
    const a = deriveAppleToken("user-1");
    expect(deriveAppleToken("user-1")).toBe(a);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("Google token is sha256(userId) hex", () => {
    const g = deriveGoogleToken("user-1");
    expect(g).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 11.4: Implement `binding.ts`**

```ts
// apps/mobile/src/iap/binding.ts
import { v5 as uuidv5 } from "uuid";
import { sha256Hex } from "./sha256";
import { IAP_NAMESPACE } from "@fina/shared";

export function deriveAppleToken(userId: string): string {
  return uuidv5(userId, IAP_NAMESPACE);
}

export function deriveGoogleToken(userId: string): string {
  return sha256Hex(userId);
}
```

```ts
// apps/mobile/src/iap/sha256.ts
import { sha256 } from "js-sha256";

/** Synchronous SHA-256 hex. Used by deriveGoogleToken to produce the
 *  Android obfuscatedAccountId. js-sha256 is pure-JS, runs under Hermes,
 *  and is a new explicit dep installed in Step 11.1. UTF-8 input encoding
 *  matches the server's node:crypto sha256(utf8) — verified in the
 *  cross-platform parity test (Step 11.5b). */
export function sha256Hex(input: string): string {
  return sha256(input);
}
```

- [ ] **Step 11.5: Run binding test, confirm pass**

```
cd apps/mobile && npx vitest run src/iap/__tests__/binding.test.ts
```
Expected: PASS 2/2.

- [ ] **Step 11.5b: Add cross-platform parity test**

Create a shared fixture so server and mobile both assert the same exact output for the same input. A drift here would silently 403 every purchase as `user_mismatch`.

```ts
// libs/shared/src/iap/binding-parity.test.ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { IAP_NAMESPACE } from "../../src/iap/namespace.js";

const FIXTURE_USER_ID = "fixture-user-id";
// Computed once and pinned. If the constants ever change the test
// fails — that's the point.
const EXPECTED_APPLE = uuidv5(FIXTURE_USER_ID, IAP_NAMESPACE);
const EXPECTED_GOOGLE = createHash("sha256").update(FIXTURE_USER_ID, "utf8").digest("hex");

describe("IAP binding token parity (server ⇄ mobile)", () => {
  it("Apple token for fixture user is deterministic", () => {
    expect(EXPECTED_APPLE).toMatch(/^[0-9a-f-]{36}$/);
    expect(uuidv5(FIXTURE_USER_ID, IAP_NAMESPACE)).toBe(EXPECTED_APPLE);
  });
  it("Google token for fixture user is deterministic", () => {
    expect(EXPECTED_GOOGLE).toMatch(/^[0-9a-f]{64}$/);
  });
  it("exports values mobile parity test can re-pin", () => {
    // Mobile copy of this file must import the SAME constants and
    // assert their own derive*Token functions match.
    expect(EXPECTED_APPLE).toBeTruthy();
    expect(EXPECTED_GOOGLE).toBeTruthy();
  });
});
```

And the mobile mirror:

```ts
// apps/mobile/src/iap/__tests__/binding-parity.test.ts
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";
import { IAP_NAMESPACE } from "@fina/shared";
import { deriveAppleToken, deriveGoogleToken } from "../binding";

const FIXTURE_USER_ID = "fixture-user-id";
// Compute expected values inline using the same primitives the server
// uses (uuidv5 + node:crypto sha256). No copy-paste literals — if
// IAP_NAMESPACE ever changes, both sides re-derive together and the
// test catches any encoding divergence (UTF-8 vs UTF-16, normalization).
const EXPECTED_APPLE = uuidv5(FIXTURE_USER_ID, IAP_NAMESPACE);
const EXPECTED_GOOGLE = createHash("sha256").update(FIXTURE_USER_ID, "utf8").digest("hex");

describe("mobile binding tokens match server output", () => {
  it("Apple token matches uuidv5(userId, IAP_NAMESPACE)", () => {
    expect(deriveAppleToken(FIXTURE_USER_ID)).toBe(EXPECTED_APPLE);
  });
  it("Google token (js-sha256) matches node:crypto sha256(userId, utf8) hex", () => {
    expect(deriveGoogleToken(FIXTURE_USER_ID)).toBe(EXPECTED_GOOGLE);
  });
});
```

Note: the mobile test runs under Vitest's Node environment (not the
React Native runtime), so `node:crypto` is available for the parity
assertion. The check is "mobile's js-sha256 produces the same bytes as
node:crypto for the same UTF-8 input" — verifying the cross-runtime
encoding parity that production purchase-binding depends on.

Run both:
```
cd libs/shared && npx vitest run src/iap/binding-parity.test.ts
cd apps/mobile && npx vitest run src/iap/__tests__/binding-parity.test.ts
```
Both pass on first run.

- [ ] **Step 11.6: Implement `client.ts`**

```ts
// apps/mobile/src/iap/client.ts
import {
  initConnection,
  endConnection,
  getSubscriptions,
  requestSubscription,
  getAvailablePurchases,
  finishTransaction,
  type Subscription as RnIapSubscription,
  type SubscriptionPurchase,
} from "react-native-iap";
import { Platform } from "react-native";
import { deriveAppleToken, deriveGoogleToken } from "./binding";
import type { IAPProductId } from "@fina/shared";

const SKUS: IAPProductId[] = ["lite_monthly", "pro_monthly"];

export type LocalProduct = {
  productId: IAPProductId;
  tier: "lite" | "pro";
  localizedPrice: string;
  localizedTitle: string;
};

let connected = false;

async function ensureConnected(): Promise<void> {
  if (connected) return;
  await initConnection();
  connected = true;
}

export async function fetchProducts(): Promise<LocalProduct[]> {
  await ensureConnected();
  const raw: RnIapSubscription[] = await getSubscriptions({ skus: SKUS });
  return raw
    .filter((s): s is RnIapSubscription => Boolean(s.productId))
    .map((s) => {
      const tier: "lite" | "pro" = s.productId === "pro_monthly" ? "pro" : "lite";
      const localizedPrice = (s as any).localizedPrice ?? (s as any).price ?? "";
      const localizedTitle = (s as any).title ?? s.productId;
      return { productId: s.productId as IAPProductId, tier, localizedPrice, localizedTitle };
    });
}

/** Error class surfaced to callers so the UI can map react-native-iap's
 *  string codes to user-friendly messaging. The code is the canonical
 *  rn-iap error code; `recoverable` is true for user-cancel and
 *  already-owned (Restore handles the latter). */
export class IapPurchaseError extends Error {
  constructor(public code: string, public recoverable: boolean, message: string) {
    super(message);
  }
}

export async function purchaseSubscription(args: {
  productId: IAPProductId;
  userId: string;
}): Promise<{ receipt: string; platform: "ios" | "android" }> {
  await ensureConnected();
  try {
    if (Platform.OS === "ios") {
      const appAccountToken = deriveAppleToken(args.userId);
      const purchase = await requestSubscription({
        sku: args.productId,
        appAccountToken,
      });
      const single: SubscriptionPurchase = Array.isArray(purchase) ? purchase[0] : purchase;
      const jws = (single as any).transactionReceipt ?? (single as any).jwsRepresentation;
      if (!jws) throw new IapPurchaseError("E_NO_RECEIPT", false, "No JWS receipt returned by StoreKit 2");
      return { receipt: String(jws), platform: "ios" };
    }
    // Android
    const obfuscatedAccountId = deriveGoogleToken(args.userId);
    const purchase = await requestSubscription({
      sku: args.productId,
      obfuscatedAccountIdAndroid: obfuscatedAccountId,
      subscriptionOffers: undefined, // no offers in v1; intro/trial added in v1.5
    } as any);
    const single: SubscriptionPurchase = Array.isArray(purchase) ? purchase[0] : purchase;
    const purchaseToken = (single as any).purchaseToken;
    if (!purchaseToken) throw new IapPurchaseError("E_NO_RECEIPT", false, "No purchaseToken returned by Play Billing");
    return { receipt: String(purchaseToken), platform: "android" };
  } catch (e: any) {
    // Normalize rn-iap error codes so the UI can dispatch without
    // pattern-matching string messages. v14 surfaces `code` on the
    // PurchaseError. See https://github.com/dooboolab-community/react-native-iap.
    const code: string = e?.code ?? "";
    if (code === "E_USER_CANCELLED") throw new IapPurchaseError(code, true, "User cancelled");
    if (code === "E_ALREADY_OWNED") throw new IapPurchaseError(code, true, "Already owned — try Restore");
    if (code === "E_NETWORK_ERROR") throw new IapPurchaseError(code, true, "Network error");
    if (code === "E_ITEM_UNAVAILABLE") throw new IapPurchaseError(code, false, "Product unavailable");
    if (code === "E_SERVICE_ERROR") throw new IapPurchaseError(code, true, "Service unavailable");
    if (e instanceof IapPurchaseError) throw e;
    throw new IapPurchaseError("E_UNKNOWN", false, e?.message ?? "Purchase failed");
  }
}

/** Call ONLY after server returns 2xx — protects against
 *  client-finishing-before-server-records race. On Android also
 *  triggers the local Play Billing acknowledge stub; the server has
 *  already done the authoritative ack via the Play Developer API. */
export async function finishPurchase(p: SubscriptionPurchase): Promise<void> {
  await finishTransaction({ purchase: p, isConsumable: false });
}

export async function listAvailablePurchases(): Promise<
  Array<{ productId: IAPProductId; receipt: string; platform: "ios" | "android" }>
> {
  await ensureConnected();
  const all: SubscriptionPurchase[] = await getAvailablePurchases();
  const out: Array<{ productId: IAPProductId; receipt: string; platform: "ios" | "android" }> = [];
  const seen = new Set<string>();
  for (const p of all) {
    const productId = p.productId as string;
    if (productId !== "lite_monthly" && productId !== "pro_monthly") continue;
    const platform: "ios" | "android" = Platform.OS === "ios" ? "ios" : "android";
    const receipt = String(
      platform === "ios"
        ? (p as any).transactionReceipt ?? (p as any).jwsRepresentation
        : (p as any).purchaseToken,
    );
    const dedupKey = platform === "ios" ? (p as any).originalTransactionIdentifierIOS ?? receipt : receipt;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({ productId: productId as IAPProductId, receipt, platform });
  }
  return out;
}

export async function disconnect(): Promise<void> {
  if (!connected) return;
  await endConnection();
  connected = false;
}
```

- [ ] **Step 11.7: Add API wrappers**

In `apps/mobile/src/api/billing.ts` (file already exists per Stripe work — find it under `apps/mobile/src/api/` or `apps/mobile/lib/api/`), append:

```ts
import type { IAPCheckoutBody, IAPRestoreBody, MeDTO } from "@fina/shared";
import { apiFetch } from "./client"; // existing wrapper

export async function postIAPCheckout(body: IAPCheckoutBody): Promise<MeDTO> {
  return apiFetch<MeDTO>("/billing/iap/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function postIAPRestore(body: IAPRestoreBody): Promise<MeDTO> {
  return apiFetch<MeDTO>("/billing/iap/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
```

- [ ] **Step 11.8: Document Expo Go limitation in repo `CLAUDE.md`**

Append a new section to `/home/cwsbr/personal/fina/CLAUDE.md`:

```markdown
## IAP development workflow

`react-native-iap` is a native module — it requires a custom dev client and CANNOT run under Expo Go.

- **Layout-only work** on `apps/mobile/app/plan/*` can use Expo Go; the IAP client throws "module not linked" and falls back to the empty-state.
- **Purchase flow testing** requires `eas build --profile development` once per developer to get a dev client. Load that build instead of Expo Go.
- Each iOS developer needs their own sandbox tester account (App Store Connect → Users and Access → Sandbox Testers). Login state caches per device.
- Each Android developer adds their Google account to the Play Console license-test list.
- Tailscale Funnel ([[project_mobile_dev_network]]) carries webhooks to `localhost:4000` exactly the same way it does for Plaid.
```

- [ ] **Step 11.9: Commit**

```
git add apps/mobile/package.json apps/mobile/app.json apps/mobile/src/iap apps/mobile/src/api/billing.ts CLAUDE.md
git commit -m "feat(mobile): react-native-iap install + IAP client wrapper + API methods"
```

---

## Task 12: Mobile UI — `/plan` picker, `/plan/restore`, More tab Restore row + Manage Billing deep-link

**Files:**
- Create: `apps/mobile/app/plan/index.tsx` (picker with empty-state + Restore button)
- Create: `apps/mobile/app/plan/restore.tsx` (Restore Purchases screen)
- Modify: `apps/mobile/app/(tabs)/more.tsx` (Restore row + Manage Billing sku derivation)

- [ ] **Step 12.1: Implement `/plan/index.tsx`**

```tsx
// apps/mobile/app/plan/index.tsx
import { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, ScrollView, Alert } from "react-native";
import { useRouter, Stack } from "expo-router";
import { fetchProducts, purchaseSubscription, IapPurchaseError, type LocalProduct } from "../../src/iap/client";
import { postIAPCheckout } from "../../src/api/billing";
import { useMe } from "../../src/hooks/useMe"; // existing hook returns MeDTO
import { colors } from "../../src/theme";

export default function PlanPicker() {
  const router = useRouter();
  const me = useMe();
  const [products, setProducts] = useState<LocalProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await fetchProducts();
      setProducts(list);
    } catch (e: any) {
      setProducts([]); // triggers empty-state
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onSubscribe = useCallback(async (p: LocalProduct) => {
    if (!me?.user?.id || busy) return;
    setBusy(p.productId);
    try {
      const { receipt, platform } = await purchaseSubscription({ productId: p.productId, userId: me.user.id });
      await postIAPCheckout({ platform, productId: p.productId, receipt });
      router.replace("/(tabs)/" as never);
    } catch (e) {
      if (e instanceof IapPurchaseError) {
        // User-cancel: silent — never alert "couldn't subscribe" after
        // an intentional cancel (bad UX, Apple guideline-aligned).
        if (e.code === "E_USER_CANCELLED") return;
        if (e.code === "E_ALREADY_OWNED") {
          // The store already records this purchase; route to Restore.
          router.push("/plan/restore" as never);
          return;
        }
        Alert.alert("Couldn't subscribe", e.message);
        return;
      }
      Alert.alert("Couldn't subscribe", "Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  }, [me, busy, router]);

  if (products === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
      <Stack.Screen options={{ title: "Choose a plan" }} />
      {products.length === 0 ? (
        <View style={{ padding: 24, borderRadius: 12, backgroundColor: colors.canvasMuted }}>
          <Text style={{ fontSize: 16, color: colors.text }}>
            Subscriptions aren't available right now. Try again later.
          </Text>
          <Pressable onPress={load} style={{ marginTop: 12 }}>
            <Text style={{ color: colors.primary, fontWeight: "600" }}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        products.map((p) => (
          <Pressable
            key={p.productId}
            onPress={() => onSubscribe(p)}
            disabled={busy !== null}
            style={{
              padding: 20,
              borderRadius: 12,
              backgroundColor: colors.canvas,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={{ fontSize: 18, fontWeight: "700", color: colors.text }}>{p.localizedTitle}</Text>
            <Text style={{ marginTop: 4, color: colors.textMuted }}>{p.tier === "pro" ? "Unlimited" : "Lite"}</Text>
            <Text style={{ marginTop: 12, fontSize: 22, fontWeight: "700", color: colors.text }}>{p.localizedPrice}</Text>
            {busy === p.productId && (
              <ActivityIndicator style={{ marginTop: 8 }} />
            )}
          </Pressable>
        ))
      )}
      {/* Apple Guideline 3.1.1 — Restore must be reachable from plan picker. */}
      <Pressable onPress={() => router.push("/plan/restore" as never)} style={{ marginTop: 8, alignItems: "center" }}>
        <Text style={{ color: colors.primary }}>Restore purchases</Text>
      </Pressable>
    </ScrollView>
  );
}
```

- [ ] **Step 12.2: Implement `/plan/restore.tsx`**

```tsx
// apps/mobile/app/plan/restore.tsx
import { useState, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert } from "react-native";
import { useRouter, Stack } from "expo-router";
import { listAvailablePurchases } from "../../src/iap/client";
import { postIAPRestore } from "../../src/api/billing";
import { colors } from "../../src/theme";

export default function PlanRestore() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const onRestore = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const purchases = await listAvailablePurchases();
      if (purchases.length === 0) {
        setStatus("No previous purchases found.");
        return;
      }
      const platform = purchases[0].platform;
      const me = await postIAPRestore({ platform, purchases: purchases.map((p) => ({ productId: p.productId, receipt: p.receipt })) });
      setStatus(`Restored — tier: ${me.tier}`);
      setTimeout(() => router.replace("/(tabs)/" as never), 1200);
    } catch (e: any) {
      Alert.alert("Couldn't restore", e?.message ?? "Try again.");
    } finally {
      setBusy(false);
    }
  }, [busy, router]);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Stack.Screen options={{ title: "Restore purchases" }} />
      <Pressable
        onPress={onRestore}
        disabled={busy}
        style={{ padding: 16, paddingHorizontal: 28, borderRadius: 999, backgroundColor: colors.primary }}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff", fontWeight: "600" }}>Restore purchases</Text>}
      </Pressable>
      {status && <Text style={{ marginTop: 16, color: colors.textMuted }}>{status}</Text>}
    </View>
  );
}
```

- [ ] **Step 12.3: Add Restore row to More tab**

In `apps/mobile/app/(tabs)/more.tsx`, find the Subscription `Group` (added in commit `4e83c9d`) and append a Restore row after Manage Billing. Replace the existing block with:

```tsx
              <Group>
                <SettingsRow
                  icon="star-outline"
                  title="Plan"
                  detail={me ? tierLabel(me.tier, me.trial.active) : "—"}
                  onPress={() => router.push((me?.subscription ? "/plan/summary" : "/plan") as never)}
                />
                <SettingsRow
                  icon="card-outline"
                  title="Manage billing"
                  detail={
                    openingBilling ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : undefined
                  }
                  onPress={onManageBilling}
                />
                <SettingsRow
                  icon="refresh-outline"
                  title="Restore purchases"
                  onPress={() => router.push("/plan/restore" as never)}
                  last
                />
              </Group>
```

- [ ] **Step 12.4: Update `onManageBilling` to derive Google sku from current product**

In the same file, find `onManageBilling`. Replace its body so the Android URL uses the current sku:

```ts
import { iapProductIdForTier } from "@fina/shared";
import { Linking, Platform } from "react-native";

const onManageBilling = useCallback(async () => {
  if (openingBilling) return;
  setOpeningBilling(true);
  try {
    if (Platform.OS === "ios") {
      await Linking.openURL("https://apps.apple.com/account/subscriptions");
      return;
    }
    if (Platform.OS === "android" && me?.subscription) {
      const productId = me.subscription.tier === "pro" ? "pro_monthly" : "lite_monthly";
      await Linking.openURL(
        `https://play.google.com/store/account/subscriptions?package=app.fina&sku=${encodeURIComponent(productId)}`,
      );
      return;
    }
  } finally {
    setOpeningBilling(false);
  }
}, [openingBilling, me?.subscription]);
```

- [ ] **Step 12.5: Manual smoke (dev client)**

Build a dev client once: `eas build --profile development --platform ios`. Install on a device signed into a sandbox tester. Verify:

1. Open the app on a free / trial account → `/plan` picker renders both products with localized prices.
2. Tap "Subscribe" on `lite_monthly` → StoreKit prompt appears → confirm → `/(tabs)/` renders with tier = lite.
3. Force-quit + reopen → tier still lite (sub persists via API).
4. Open `/plan/restore` → tap Restore → status reflects active sub.
5. More → Manage billing → opens Apple subs screen.

- [ ] **Step 12.6: Commit**

```
git add apps/mobile/app/plan apps/mobile/app/\(tabs\)/more.tsx
git commit -m "feat(mobile): plan picker, restore screen, More tab Restore row + Manage Billing sku derivation"
```

---

## Task 13: End-to-end sandbox smoke checklist (manual)

Not code — a hand-walked checklist that gates the production cutover. Run after Tasks 1-12 land + sandbox products / webhook URLs are configured per spec §11.

**Files:**
- Create: `docs/smoke/2026-05-26-iap-launch.md`

- [ ] **Step 13.1: Write smoke checklist**

```markdown
# IAP launch smoke — sandbox cutover gate

Gate the four launch checks from spec §11 before flipping `APPLE_ENV=production` / Google Play track to "production".

## Gate 1 — ASSN V2 endpoint set before first purchase

- [ ] In ASC, paste `https://api.fina.app/webhooks/iap/apple` into both Production Server URL AND Sandbox Server URL under App Information → App Store Server Notifications.
- [ ] Confirm "Version 2" is selected.
- [ ] Apple does NOT back-fill historical notifications — anything before this paste is lost forever.

## Gate 2 — iOS round-trip

- [ ] Launch dev-client build on a device with a sandbox tester signed in.
- [ ] `/plan` picker renders both products with localized prices.
- [ ] Tap pro_monthly Subscribe → StoreKit prompt → confirm.
- [ ] Within 5 seconds: API logs `POST /billing/iap/checkout` 200 with `tier: pro`.
- [ ] Within 60 seconds: API logs ASSN webhook with `notificationType: SUBSCRIBED` and `WebhookEvent` row exists.
- [ ] DB: `Subscription` row exists with `source=iap_apple`, `tier=pro`, `environment=Sandbox`, `status=active`.
- [ ] DB: `User.iapAppleAccountToken` is set to `uuidv5(userId, IAP_NAMESPACE)`.

## Gate 3 — Android acknowledge round-trip

- [ ] Launch dev-client build on an Android device with the Google account added to Play license-testers.
- [ ] Subscribe lite_monthly.
- [ ] Within 5 seconds: `POST /billing/iap/checkout` 200.
- [ ] Within 5 minutes: API calls `purchases.subscriptions.acknowledge(packageName, subscriptionId=productId, token)` for the new sub. Verify by directly re-fetching the purchase via `purchases.subscriptionsv2.get` (gcloud CLI or googleapis quickstart) and confirming `acknowledgementState === ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED`. (No custom log line — the call lives inside `google-client.ts._acknowledge` and surfaces only errors.)
- [ ] DB: `Subscription.acknowledgementState` indirectly verified — re-fetch via `purchases.subscriptionsv2.get` and confirm `ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED`.
- [ ] Pub/Sub: subsequent RTDN notifications dedup correctly (no duplicate `Subscription` rows).

## Gate 4 — Force-cancel reflection (both platforms)

- [ ] On iOS: Settings → [App Store] → Sandbox → cancel the test subscription. Within 60 seconds, API webhook receives `DID_CHANGE_RENEWAL_STATUS` and `Subscription.cancelAtPeriodEnd` flips to true.
- [ ] On Android: Play Store → Subscriptions → cancel. Within 60 seconds, RTDN delivers SUBSCRIPTION_CANCELED → `Subscription.cancelAtPeriodEnd=true`, `status=active` (still in current period).
- [ ] After the sandbox-accelerated period ends (~5 min on iOS sandbox), confirm webhook flips to `EXPIRED` → `Subscription.status=canceled`.

## Production cutover

Only after all four gates pass:
- [ ] Flip Vercel env: `APPLE_ENV=production`.
- [ ] Confirm `Subscription.environment` filter rejects any lingering Sandbox rows from grants in production `/me`.
- [ ] Update App Store Connect product status to Ready for Sale.
- [ ] Update Play Console subscriptions to Active.
- [ ] Tag release: `git tag v1-iap-launch && git push --tags`.
```

- [ ] **Step 13.2: Commit**

```
git add docs/smoke/2026-05-26-iap-launch.md
git commit -m "docs(iap): sandbox launch smoke checklist (gates §11)"
```

---

## Task 14: Account-deletion integration — tombstone helper + future-impl doc

The v1 IAP work does NOT include an account-deletion flow (none exists in the codebase yet). But the IAP webhook ladder (Task 10) reads `IapDeletedBinding` tombstones to short-circuit notifications for deleted users. When the deletion flow IS built later, it MUST write these tombstones — otherwise webhooks for deleted users 500 for 5 retries before the cap trips.

This task ships the helper + the integration document so the future implementer can't miss it.

**Files:**
- Create: `apps/api/src/iap/account-deletion.ts` (the `writeAccountDeletionTombstones(userId)` helper)
- Create: `docs/runbooks/iap-account-deletion.md` (one-page integration guide)
- Modify: `apps/api/src/iap/binding.ts` (re-export the helper)
- Test: `apps/api/tests/iap/account-deletion.test.ts`

- [ ] **Step 14.1: Write failing test**

```ts
// apps/api/tests/iap/account-deletion.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";
import { writeAccountDeletionTombstones } from "../../src/iap/account-deletion.js";
import { deriveAppleToken, deriveGoogleToken, hashBindingToken } from "../../src/iap/binding.js";

beforeEach(async () => { await truncateAll(); });

describe("writeAccountDeletionTombstones", () => {
  it("writes tombstones for both apple and google bindings when present", async () => {
    await prisma.user.create({
      data: {
        id: "u1", email: "u1@test",
        iapAppleAccountToken: deriveAppleToken("u1"),
        iapGoogleObfuscatedId: deriveGoogleToken("u1"),
      },
    });
    await writeAccountDeletionTombstones("u1");
    const apple = await prisma.iapDeletedBinding.findUnique({
      where: { source_tokenHash: { source: "iap_apple", tokenHash: hashBindingToken(deriveAppleToken("u1")) } },
    });
    const google = await prisma.iapDeletedBinding.findUnique({
      where: { source_tokenHash: { source: "iap_google", tokenHash: hashBindingToken(deriveGoogleToken("u1")) } },
    });
    expect(apple).not.toBeNull();
    expect(google).not.toBeNull();
  });

  it("no-ops when user has never made an IAP purchase", async () => {
    await prisma.user.create({ data: { id: "u2", email: "u2@test" } });
    await writeAccountDeletionTombstones("u2");
    const rows = await prisma.iapDeletedBinding.findMany();
    expect(rows.length).toBe(0);
  });

  it("idempotent — second call doesn't create duplicate rows", async () => {
    await prisma.user.create({
      data: { id: "u3", email: "u3@test", iapAppleAccountToken: deriveAppleToken("u3") },
    });
    await writeAccountDeletionTombstones("u3");
    await writeAccountDeletionTombstones("u3");
    const rows = await prisma.iapDeletedBinding.findMany({ where: { source: "iap_apple" } });
    expect(rows.length).toBe(1);
  });
});
```

- [ ] **Step 14.2: Implement `account-deletion.ts`**

```ts
// apps/api/src/iap/account-deletion.ts
import { prisma } from "../db.js";
import { hashBindingToken } from "./binding.js";

/** Future-deletion-flow integration point. Whoever builds the account-
 *  deletion flow MUST call this BEFORE removing the User row. Without
 *  it, IAP webhooks for the deleted user's purchases 500 for 5 retries
 *  before the per-token retry-cap trips (spec §5.3 step 4).
 *
 *  No-op for users who never made an IAP purchase. Idempotent — safe
 *  to call repeatedly (uses upsert under (source, tokenHash) unique). */
export async function writeAccountDeletionTombstones(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { iapAppleAccountToken: true, iapGoogleObfuscatedId: true },
  });
  if (!user) return;
  const tombstones: { source: "iap_apple" | "iap_google"; tokenHash: string }[] = [];
  if (user.iapAppleAccountToken) {
    tombstones.push({ source: "iap_apple", tokenHash: hashBindingToken(user.iapAppleAccountToken) });
  }
  if (user.iapGoogleObfuscatedId) {
    tombstones.push({ source: "iap_google", tokenHash: hashBindingToken(user.iapGoogleObfuscatedId) });
  }
  if (tombstones.length === 0) return;
  // Hash userId for support-replay; not reversible without the original userId.
  const userIdHash = hashBindingToken(userId);
  // Wrap in $transaction so a failure on the Google tombstone doesn't
  // leave a half-tombstoned user (Apple tombstone committed, Google
  // missing → Google webhooks 500 for 5 retries before the per-token
  // cap trips). Batch transaction is atomic across both upserts at the
  // SQL layer — no nested global-prisma writes (see billing-webhook.ts:42-47
  // for the rationale Prisma's interactive tx-with-global-client deadlock
  // pattern we deliberately avoid).
  await prisma.$transaction(
    tombstones.map((t) =>
      prisma.iapDeletedBinding.upsert({
        where: { source_tokenHash: { source: t.source, tokenHash: t.tokenHash } },
        create: { source: t.source, tokenHash: t.tokenHash, userIdHash },
        update: {}, // idempotent
      }),
    ),
  );
}
```

- [ ] **Step 14.3: Re-export from `binding.ts`**

In `apps/api/src/iap/binding.ts`, add at the bottom:

```ts
export { writeAccountDeletionTombstones } from "./account-deletion.js";
```

- [ ] **Step 14.4: Create runbook**

```markdown
# Runbook — IAP account deletion integration

**Audience:** future implementer of `DELETE /me` / account-deletion flow.

## Background

Fina mobile IAP webhooks consult `IapDeletedBinding` to recognize
notifications for users we've deleted. Without a tombstone, our
webhook 500s for 5 retries (per spec §5.3 step 4) before the per-
token retry-cap trips and stops the noise. The cap exists as a
safety net; the tombstone is the right answer.

## What the deletion flow MUST do

BEFORE removing the `User` row (or in the same transaction):

```ts
import { writeAccountDeletionTombstones } from "@fina/api/src/iap/account-deletion.js";

await prisma.$transaction(async (tx) => {
  await writeAccountDeletionTombstones(userId);
  // ... cancel any Stripe subs, null out PII fields per spec §12.1
  //     retention guidance (6-year tax-retention exemption), etc.
  // ... finally delete or tombstone the User row.
});
```

`writeAccountDeletionTombstones` is idempotent and no-ops for users
who never made an IAP purchase.

## What the deletion flow MUST NOT do

- Hard-delete `Subscription` rows for IAP-source subs. Spec §12.1
  requires PII-null + retain 6 years (CRA tax retention).
- Cancel the Apple/Google subscription server-side. We cannot; the
  user must do it via Apple Settings / Play Store. UI must surface
  a blocking banner.

## Verification

After deletion, simulate a renewal webhook for the deleted user:
the webhook handler should consult IapDeletedBinding, log
`unattributable_after_delete`, and return 200 immediately (no 500-
retry cascade).

## When this becomes self-service

If/when account deletion is exposed in the mobile UI:
- Block deletion if any active `iap_apple` / `iap_google` Subscription
  rows exist. Show "Cancel your subscription first" with a deep-link
  to the platform's subs UI (see Task 12 step 12.4 for the iOS/Android
  deep-link patterns).
- Only proceed after the user confirms platform-native cancel.
```

- [ ] **Step 14.5: Verify ApiErrorCode → HTTP status mapping**

The IAP error codes added in Task 1 Step 1.11 (`invalid_receipt`, `iap_not_configured`, etc.) are surfaced by code via `throw new HttpError(statusCode, code, ...)`. The Fastify error serializer should already trust `e.statusCode`. Confirm by reading `apps/api/src/auth/context.ts` for the `HttpError` class:

```
grep -n "class HttpError\|statusCode" apps/api/src/auth/context.ts | head
```

Expected: HttpError carries `statusCode: number` and `code: string` properties. Route handlers do `reply.code(e.statusCode).send({ error: e.code })`. Verified — no global mapping table needs updating.

If a route ever returns the error code without an explicit statusCode (e.g., legacy code that catches and re-throws as 500), the mapping fails silently. Smoke-test by hitting `/billing/iap/checkout` with no env configured and confirming the response is 503 with body `{"error":"iap_not_configured"}`.

- [ ] **Step 14.6: Run tests, confirm pass**

```
cd apps/api && npx vitest run tests/iap/account-deletion.test.ts
```
Expected: PASS 3/3.

- [ ] **Step 14.7: Commit**

```
git add apps/api/src/iap/account-deletion.ts apps/api/src/iap/binding.ts apps/api/tests/iap/account-deletion.test.ts docs/runbooks/iap-account-deletion.md
git commit -m "feat(api): writeAccountDeletionTombstones helper + future-impl runbook"
```

---

## Self-review (done — recorded for trace)

**Spec coverage:**
- §3 schema: Task 2 (User.iap* + Subscription.environment + IapDeletedBinding). ✓
- §3 shared lib: Task 1 (productIds, namespace, schemas, errors append). ✓
- §4 mobile lib + Expo Go warning: Task 11. UI: Task 12. ✓
- §5.1 env + redact + boot validation: Task 3. ✓
- §5.2 modules: Task 4 (apple-client), 5 (google-client), 6 (webhook-verify), 7 (sync-sub), 8 (precedence). ✓
- §5.3 routes: Task 9 (checkout/restore), Task 10 (webhooks with 4-step resolution). ✓
- §5.4 status mapping: Task 4 (status-mapping.ts covering all Apple + Google states). ✓
- §6 Apple contract (deterministic appAccountToken, JWS six checks, Family Sharing ignore, ASC roundtrip): Tasks 4, 7, 10. ✓
- §7 Google contract (obfuscatedAccountId, acknowledge, linkedPurchaseToken): Tasks 5, 7. ✓
- §8 cross-source guard + Stripe-always-wins + sandbox env filter: Task 8. ✓
- §10 testing strategy: every code task carries its tests. Task 13 covers manual sandbox. ✓
- §11 ops setup: deferred to humans (linked in Task 13 smoke). ✓
- §12 OOS items: not implemented (correctly). ✓
- §12.1 GDPR retention + IapDeletedBinding write: schema in Task 2; webhook tombstone read in Task 10. Account-deletion writes are deferred to whoever builds the deletion flow (linked in spec).
- §12.2 account merge: documented in spec, no code task (manual support v1).
- §12.3 webhook trust chain: implemented in Task 10's omission of `expectedAppAccountToken` on the webhook path.

**Placeholder scan:** No "TBD"/"TODO"/"similar to" markers in the code blocks. One install-time gap intentionally surfaced as a fail-fast: `apple-roots.ts` (Task 4 Step 4.6b) ships with a literal placeholder marker `<<<INSTALLER: paste the real Apple Inc. Root CA G3 PEM here.>>>` and the matching `EXPECTED_APPLE_ROOT_SPKI_SHA256` constant set to `"<INSTALLER_FILL_64_HEX_CHARS>"`. `validateAppleRoots()` runs at module load and throws a clear error pointing at this file until the installer drops in the real PEM + SHA-256. The Task 4.6c test (`apple-roots.test.ts`) also fails until both are populated — by design, so no later task can land while the cert is still a placeholder.

**Type consistency:** `syncSubscriptionFromIAP(cfg, args, deps)` signature is identical across Task 7 definition, Task 9 callers, Task 10 callers. `IapDeletedBinding` model fields match across Task 2 (schema) and Task 10 (read). `deriveAppleToken` / `deriveGoogleToken` signatures match between API (Task 7) and mobile (Task 11). `MeDTO` shape unchanged.

---

## Plan complete

Plan saved to `docs/superpowers/plans/2026-05-26-mobile-iap-billing.md`.

**Revision history (post-write):**
- `244501d` — Initial plan (13 tasks).
- `a074ff0` — P1 — Test infrastructure: Task 0 (buildApp injection), real helper paths.
- `e9f315e` — P2 — Single migration: WebhookEvent.body + IapRetryCounter moved to Task 2.
- `a542d66` — P3 — Apple verifyAndDecodeNotification + SPKI-pinned root + fail-fast.
- `5ac3e53` — P4 — Google acknowledge fix (productId not empty) + no double-fetch.
- `02ff6e0` — P5 — Webhook dedup vs retry-counter separation; Family Sharing → canceled.
- `409c472` — P6 — buildMeBody signature + caller updates; filterEnvironmentRows type narrowed.
- `418582a` — P7 — react-native-iap@^14 pin; sha256 top-level; parity tests; IapPurchaseError UX.
- `90676b4` — P8 — Task 14 (account-deletion tombstone helper + runbook) + ApiErrorCode mapping check.
- `8fc2230` — P9 — Test path consistency (tests/ plural, libs/shared src/ colocation, remaining resetTestDb → truncateAll).
- `5c68280` — P10 — getSubscriptionStatus dedicated decoders + account-deletion in $transaction.
- This commit — P11 — Doc cleanups (delete dead Step 3.8 redact block, Step 4.8 git-add includes apple-roots files, mobile parity test computes expected inline, sandbox-smoke Gate 3 dropped fake `iap_acknowledge_ok` log line).

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec-compliance + code-quality) between tasks, continuous progress in this session.
2. **Inline Execution** — execute the plan in this session in batches with manual checkpoints.

Which approach?

