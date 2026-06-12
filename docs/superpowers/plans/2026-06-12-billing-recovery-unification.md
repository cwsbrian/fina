# Billing Recovery Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one source-agnostic billing recovery state and recovery flow for Apple IAP, Google Play IAP, and Stripe.

**Architecture:** Keep the durable lock as `User.isPlanMismatch`, but expose it through a new `MeDTO.billingRecovery` object. Reuse existing IAP restore endpoints for Apple/Google and existing `/billing/sync` for Stripe; mobile dispatches the correct provider action based on `billingRecovery.action`.

**Tech Stack:** TypeScript, Fastify, Prisma, Vitest, React Native/Expo, shared `@fina/shared` DTOs.

---

## File Structure

- Modify `libs/shared/src/dto/me.ts`: add `BillingRecoveryDTO` and `MeDTO.billingRecovery`.
- Create `apps/api/src/billing/recovery.ts`: source-agnostic mapping from user/primary subscription/IAP device to `billingRecovery`.
- Modify `apps/api/src/routes/me.ts`: include `billingRecovery` in `/me`.
- Modify `apps/api/src/routes/billing.ts`: include `billingRecovery` in `/billing/sync` responses and clear mismatch when Stripe sync converges.
- No direct edit expected in `apps/api/src/routes/billing-iap.ts`: existing restore/checkout responses receive `billingRecovery` through `buildMeBody`.
- Modify `apps/mobile/src/api/billing.ts`: add `postBillingSync`.
- Create `apps/mobile/src/billing/recovery-ui.ts`: small pure helpers for lock checks, recovery labels, and provider footnotes.
- Create `apps/mobile/src/billing/recovery-ui.test.ts`: mobile recovery copy/action tests.
- Modify `apps/mobile/src/iap/sync.ts`: keep native integrity checks but consume `billingRecovery` for lock decisions.
- Modify `apps/mobile/app/(tabs)/index.tsx` and `apps/mobile/app/(tabs)/more.tsx`: route locked users using `billingRecovery.locked`.
- Modify `apps/mobile/app/plan/index.tsx`: one recovery function that dispatches `restore_iap` or `sync_stripe`.
- Test `apps/api/tests/billing-sync.test.ts`: Stripe recovery state and clearing behavior.
- Test `apps/api/tests/iap/billing-iap.routes.test.ts`: Apple/Google recovery state mapping.
- Test `apps/api/tests/me.test.ts`: normal `/me` recovery state.

---

### Task 1: Shared DTO and Server Recovery Mapper

**Files:**
- Modify: `libs/shared/src/dto/me.ts`
- Create: `apps/api/src/billing/recovery.ts`
- Modify: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/routes/billing.ts`
- Test: `apps/api/tests/me.test.ts`
- Test: `apps/api/tests/billing-sync.test.ts`
- Test: `apps/api/tests/iap/billing-iap.routes.test.ts`

- [ ] **Step 1: Write failing API expectations**

Add these assertions to existing tests before implementation.

In `apps/api/tests/me.test.ts`, inside `it("returns user + tier=pro + trial active for fresh signup", ...)`, add:

```ts
expect(body.billingRecovery).toEqual({
  locked: false,
  reason: null,
  source: null,
  action: null,
  lastCheckedAt: null,
});
```

In `apps/api/tests/billing-sync.test.ts`, inside `it("no-op for user with neither sessionId nor stripeCustomerId", ...)`, add:

```ts
expect(res.json().billingRecovery).toEqual({
  locked: false,
  reason: null,
  source: null,
  action: null,
  lastCheckedAt: null,
});
```

In `apps/api/tests/billing-sync.test.ts`, add a new test before the anonymous test:

```ts
it("maps a Stripe plan mismatch to sync_stripe and clears it after Stripe sync", async () => {
  const app = await buildApp(env);
  const user = await signUpAndGetCookie(app, { email: "s5@example.com", name: "S Five" });
  await prisma.user.update({
    where: { id: user.userId },
    data: { stripeCustomerId: "cus_s5", isPlanMismatch: true },
  });
  await prisma.subscription.create({
    data: {
      userId: user.userId,
      tier: "pro",
      source: "stripe",
      sourceSubscriptionId: "sub_s5",
      sourceCustomerId: "cus_s5",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      billingPeriod: "monthly",
    },
  });
  stripe.fns.subsList.mockResolvedValue({
    data: [fakeStripeSub({ id: "sub_s5", customer: "cus_s5", priceId: env.STRIPE_PRICE_PRO_MONTHLY })],
  });
  stripe.fns.subsRetrieve.mockResolvedValue(
    fakeStripeSub({ id: "sub_s5", customer: "cus_s5", priceId: env.STRIPE_PRICE_PRO_MONTHLY }),
  );

  const locked = await app.inject({
    method: "GET",
    url: "/me",
    headers: { cookie: user.cookie },
  });
  expect(locked.statusCode).toBe(200);
  expect(locked.json().billingRecovery).toMatchObject({
    locked: true,
    reason: "plan_mismatch",
    source: "stripe",
    action: "sync_stripe",
  });

  const res = await app.inject({
    method: "POST",
    url: "/billing/sync",
    headers: { cookie: user.cookie, "content-type": "application/json" },
    payload: {},
  });

  expect(res.statusCode).toBe(200);
  expect(res.json().billingRecovery.locked).toBe(false);
  const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
  expect(fresh.isPlanMismatch).toBe(false);
});
```

In `apps/api/tests/billing-sync.test.ts`, add this negative test immediately after the Stripe clearing test:

```ts
it("does not clear a Stripe mismatch when only an inactive Stripe row is re-fetched", async () => {
  const app = await buildApp(env);
  const user = await signUpAndGetCookie(app, { email: "s6@example.com", name: "S Six" });
  await prisma.user.update({
    where: { id: user.userId },
    data: { stripeCustomerId: "cus_s6", isPlanMismatch: true },
  });
  await prisma.subscription.create({
    data: {
      userId: user.userId,
      tier: "pro",
      source: "stripe",
      sourceSubscriptionId: "sub_s6",
      sourceCustomerId: "cus_s6",
      status: "canceled",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      billingPeriod: "monthly",
    },
  });
  stripe.fns.subsList.mockResolvedValue({
    data: [
      fakeStripeSub({
        id: "sub_s6",
        customer: "cus_s6",
        priceId: env.STRIPE_PRICE_PRO_MONTHLY,
        status: "canceled",
      }),
    ],
  });
  stripe.fns.subsRetrieve.mockResolvedValue(
    fakeStripeSub({
      id: "sub_s6",
      customer: "cus_s6",
      priceId: env.STRIPE_PRICE_PRO_MONTHLY,
      status: "canceled",
    }),
  );

  const res = await app.inject({
    method: "POST",
    url: "/billing/sync",
    headers: { cookie: user.cookie, "content-type": "application/json" },
    payload: {},
  });

  expect(res.statusCode).toBe(200);
  expect(res.json().billingRecovery.locked).toBe(true);
  const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
  expect(fresh.isPlanMismatch).toBe(true);
});
```

In `apps/api/tests/iap/billing-iap.routes.test.ts`, add this expectation to the Apple mismatch test after `expect(res.json().iapIntegrity.isPlanMismatch).toBe(true);`:

```ts
expect(res.json().billingRecovery).toMatchObject({
  locked: true,
  reason: "plan_mismatch",
  source: "iap_apple",
  action: "restore_iap",
});
```

Add a Google mapping test in `apps/api/tests/iap/billing-iap.routes.test.ts` under `describe("POST /billing/iap/integrity-check", ...)`:

```ts
it("maps a Google plan mismatch to restore_iap", async () => {
  const { cookie, userId } = await signUpAndGetCookie(app, { email: "u11@test.com" });
  await prisma.subscription.create({
    data: {
      userId,
      tier: "pro",
      source: "iap_google",
      sourceSubscriptionId: "google-integrity-1",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      environment: "Sandbox",
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/billing/iap/integrity-check",
    headers: {
      cookie,
      [CLIENT_DEVICE_ID_HEADER]: "android-device-integrity-1",
      [CLIENT_PLATFORM_HEADER]: "android",
    },
    payload: {
      platform: "android",
      result: "matched",
      nativeProductId: "max_monthly",
    },
  });

  expect(res.statusCode).toBe(200);
  expect(res.json().billingRecovery).toMatchObject({
    locked: true,
    reason: "plan_mismatch",
    source: "iap_google",
    action: "restore_iap",
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec nx test api -- --run tests/me.test.ts tests/billing-sync.test.ts tests/iap/billing-iap.routes.test.ts
```

Expected: FAIL because `billingRecovery` is not present on `MeDTO` responses.

- [ ] **Step 3: Add shared DTO type**

Update `libs/shared/src/dto/me.ts` by adding this type before `MeDTO`:

```ts
export type BillingRecoveryDTO = {
  locked: boolean;
  reason: "plan_mismatch" | null;
  source: SubscriptionDTO["source"] | null;
  action: "restore_iap" | "sync_stripe" | null;
  lastCheckedAt: string | null;
};
```

Then add this field inside `MeDTO`, immediately after `subscription`:

```ts
  /** Source-agnostic billing lock/recovery state. Native IAP and Stripe use
   *  different recovery actions, but app lock decisions should use this shape. */
  billingRecovery: BillingRecoveryDTO;
```

- [ ] **Step 4: Create server recovery mapper**

Create `apps/api/src/billing/recovery.ts`:

```ts
import type { Subscription, User, UserDevice } from "@prisma/client";
import type { BillingRecoveryDTO, SubscriptionDTO } from "@fina/shared";

type RecoverySub = Pick<Subscription, "source"> | null;
type RecoveryUser = Pick<User, "isPlanMismatch">;
type RecoveryDevice =
  | Pick<UserDevice, "lastIapIntegrityCheckedAt">
  | null;

function recoveryActionForSource(
  source: SubscriptionDTO["source"] | null,
): BillingRecoveryDTO["action"] {
  if (source === "iap_apple" || source === "iap_google") return "restore_iap";
  if (source === "stripe") return "sync_stripe";
  return null;
}

export function billingRecoveryForMe(
  user: RecoveryUser,
  primary: RecoverySub,
  device: RecoveryDevice,
): BillingRecoveryDTO {
  const source = (primary?.source ?? null) as SubscriptionDTO["source"] | null;
  const lastCheckedAt = device?.lastIapIntegrityCheckedAt?.toISOString() ?? null;

  if (!user.isPlanMismatch) {
    return {
      locked: false,
      reason: null,
      source: null,
      action: null,
      lastCheckedAt,
    };
  }

  return {
    locked: true,
    reason: "plan_mismatch",
    source,
    action: recoveryActionForSource(source),
    lastCheckedAt,
  };
}
```

- [ ] **Step 5: Wire mapper into `/me` and `buildMeBody`**

In `apps/api/src/routes/me.ts`, import:

```ts
import { billingRecoveryForMe } from "../billing/recovery.js";
```

In `toMeDTO`, add this property immediately before `iapIntegrity`:

```ts
    billingRecovery: billingRecoveryForMe(user, primary, iapDevice),
```

In `apps/api/src/routes/billing.ts`, import:

```ts
import { billingRecoveryForMe } from "../billing/recovery.js";
```

In `buildMeBody`, add this property immediately before `iapIntegrity`:

```ts
    billingRecovery: billingRecoveryForMe(user, primary, null),
```

- [ ] **Step 6: Clear Stripe mismatch after successful Stripe convergence**

In `apps/api/src/routes/billing.ts`, inside `POST /billing/sync`, track the exact Stripe subscription IDs successfully re-fetched during this sync:

```ts
      const syncedStripeSubscriptionIds = new Set<string>();
```

In Path A, add the session subscription ID to the set only when `syncSubscriptionFromStripe` returns a row:

```ts
          if (synced) {
            syncedStripeSubscriptionIds.add(subId);
            await reconcilePlaidItemsForUser(app.fina.env, user.id);
          }
```

In Path B, add the listed subscription ID to the set only when `syncSubscriptionFromStripe` returns a row:

```ts
          if (synced) {
            syncedStripeSubscriptionIds.add(sub.id);
            await reconcilePlaidItemsForUser(app.fina.env, user.id);
          }
```

After Path B finishes and before `return await buildMeBody(...)`, clear the lock only when the current primary active subscription is Stripe and that exact primary row was re-fetched during this sync:

```ts
      if (syncedStripeSubscriptionIds.size > 0) {
        const activeAfterStripeSync = await prisma.subscription.findMany({
          where: {
            userId: user.id,
            status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] },
          },
          orderBy: { currentPeriodEnd: "desc" },
        });
        const runtimeEnv = app.fina.env.APPLE_ENV === "production" ? "production" : "sandbox";
        const primaryAfterStripeSync = pickPrimarySub(
          filterEnvironmentRows(activeAfterStripeSync, runtimeEnv),
        );
        if (
          primaryAfterStripeSync?.source === "stripe" &&
          syncedStripeSubscriptionIds.has(primaryAfterStripeSync.sourceSubscriptionId)
        ) {
          await prisma.user.update({
            where: { id: user.id },
            data: { isPlanMismatch: false },
          });
        }
      }
```

- [ ] **Step 7: Run focused API tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec nx test api -- --run tests/me.test.ts tests/billing-sync.test.ts tests/iap/billing-iap.routes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit server contract work**

Run:

```bash
git add libs/shared/src/dto/me.ts apps/api/src/billing/recovery.ts apps/api/src/routes/me.ts apps/api/src/routes/billing.ts apps/api/tests/me.test.ts apps/api/tests/billing-sync.test.ts apps/api/tests/iap/billing-iap.routes.test.ts
git commit -m "Add unified billing recovery state"
```

Expected: commit succeeds.

---

### Task 2: Mobile Billing Sync Client and Lock Routing

**Files:**
- Modify: `apps/mobile/src/api/billing.ts`
- Create: `apps/mobile/src/billing/recovery-ui.ts`
- Modify: `apps/mobile/src/iap/sync.ts`
- Modify: `apps/mobile/app/(tabs)/index.tsx`
- Modify: `apps/mobile/app/(tabs)/more.tsx`

- [ ] **Step 1: Add Stripe sync mobile client**

In `apps/mobile/src/api/billing.ts`, add `SyncBody` to the import:

```ts
import type {
  IAPCheckoutBody,
  IAPIntegrityCheckBody,
  IAPRestoreBody,
  MeDTO,
  SyncBody,
} from "@fina/shared";
```

Add this function after `postIAPIntegrityCheck`:

```ts
export async function postBillingSync(body: SyncBody = {}): Promise<MeDTO> {
  return await apiFetch<MeDTO>("/billing/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
```

- [ ] **Step 2: Create mobile billing lock helper**

Create `apps/mobile/src/billing/recovery-ui.ts`:

```ts
import type { MeDTO } from "@fina/shared";

type BillingLockShape = Pick<MeDTO, "billingRecovery" | "iapIntegrity">;

export function isBillingLocked(me: BillingLockShape): boolean {
  return me.billingRecovery?.locked ?? me.iapIntegrity.isPlanMismatch;
}
```

In `apps/mobile/src/iap/sync.ts`, import:

```ts
import { isBillingLocked } from "../billing/recovery-ui";
```

Update `shouldCheckNativeIntegrity`:

```ts
  if (isBillingLocked(me)) return false;
```

Replace the old direct mismatch guard in that function:

```ts
  if (me.iapIntegrity.isPlanMismatch) return false;
```

with the new `isBillingLocked(me)` guard.

- [ ] **Step 3: Route Home lock checks through billingRecovery**

In `apps/mobile/app/(tabs)/index.tsx`, replace:

```ts
      if (meData.iapIntegrity.isPlanMismatch) {
        router.replace("/plan" as never);
        return;
      }
```

with:

```ts
      if (isBillingLocked(meData)) {
        router.replace("/plan" as never);
        return;
      }
```

Add the import:

```ts
import { isBillingLocked } from "../../src/billing/recovery-ui";
```

In `apps/mobile/app/(tabs)/more.tsx`, replace:

```ts
        if (nextMe.iapIntegrity.isPlanMismatch) router.push("/plan" as never);
```

with:

```ts
        if (isBillingLocked(nextMe)) {
          router.push("/plan" as never);
        }
```

Add the import:

```ts
import { isBillingLocked } from "../../src/billing/recovery-ui";
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
pnpm exec nx typecheck mobile
```

Expected: PASS.

- [ ] **Step 5: Commit mobile client/routing work**

Run:

```bash
git add apps/mobile/src/api/billing.ts apps/mobile/src/billing/recovery-ui.ts apps/mobile/src/iap/sync.ts 'apps/mobile/app/(tabs)/index.tsx' 'apps/mobile/app/(tabs)/more.tsx'
git commit -m "Use billing recovery for mobile lock routing"
```

Expected: commit succeeds.

---

### Task 3: Unified Plan Screen Recovery Action

**Files:**
- Modify: `apps/mobile/src/billing/recovery-ui.ts`
- Create: `apps/mobile/src/billing/recovery-ui.test.ts`
- Modify: `apps/mobile/app/plan/index.tsx`

- [ ] **Step 1: Import Stripe sync client and recovery helpers**

In `apps/mobile/app/plan/index.tsx`, add:

```ts
import { postBillingSync } from "../../src/api/billing";
```

Also add:

```ts
import {
  billingRecoveryButtonLabel,
  billingRecoveryFootnote,
  billingRecoveryLockCopy,
  isBillingLocked,
} from "../../src/billing/recovery-ui";
```

- [ ] **Step 2: Extend recovery helpers and add mobile tests**

Replace `apps/mobile/src/billing/recovery-ui.ts` with:

```ts
import type { MeDTO } from "@fina/shared";

type BillingLockShape = Pick<MeDTO, "billingRecovery" | "iapIntegrity">;
type BillingRecoveryShape = Pick<MeDTO, "billingRecovery" | "iapIntegrity" | "subscription">;

export function isBillingLocked(me: BillingLockShape): boolean {
  return me.billingRecovery?.locked ?? me.iapIntegrity.isPlanMismatch;
}

export function billingRecoveryButtonLabel(me: BillingRecoveryShape): string {
  switch (me.billingRecovery?.action ?? null) {
    case "sync_stripe":
      return "Sync billing";
    case "restore_iap":
      return "Restore purchases";
    case null:
      return "Contact support";
  }
}

export function billingRecoveryLockCopy(me: BillingRecoveryShape): string {
  if ((me.billingRecovery?.action ?? null) === null) {
    return "We could not determine where this subscription is managed.";
  }
  return "This Fina account and your billing provider do not match.";
}

export function billingRecoveryFootnote(me: BillingRecoveryShape, storeName: string): string {
  if (me.subscription?.source === "stripe" || me.billingRecovery?.action === "sync_stripe") {
    return "Fina web billing handles payment, cancellation, and subscription changes.";
  }
  return `${storeName} handles payment, cancellation, and subscription changes.`;
}
```

Create `apps/mobile/src/billing/recovery-ui.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MeDTO } from "@fina/shared";
import {
  billingRecoveryButtonLabel,
  billingRecoveryFootnote,
  billingRecoveryLockCopy,
  isBillingLocked,
} from "./recovery-ui";

function me(overrides: Partial<MeDTO>): MeDTO {
  return {
    user: {
      id: "u1",
      email: "u@example.com",
      name: null,
      tz: "America/Vancouver",
      locale: "en",
      morningTime: "08:00",
      snoozeUntil: null,
      pauseEnabled: false,
      notificationPrefs: {
        morningBrief: true,
        bankReconnect: true,
        workspaceInvites: true,
        trialExpiring: true,
        goalMilestones: true,
        largeCharges: true,
        transactionAdded: true,
        productUpdates: true,
      },
      categorizationMode: "flexible",
    },
    tier: "pro",
    trial: { active: false, endsAt: null },
    subscription: null,
    billingRecovery: {
      locked: false,
      reason: null,
      source: null,
      action: null,
      lastCheckedAt: null,
    },
    iapIntegrity: {
      isPlanMismatch: false,
      requiresCheck: false,
      lastCheckedAt: null,
    },
    ...overrides,
  };
}

describe("billing recovery UI helpers", () => {
  it("uses billingRecovery.locked for app lock decisions", () => {
    expect(
      isBillingLocked(
        me({
          billingRecovery: {
            locked: true,
            reason: "plan_mismatch",
            source: "stripe",
            action: "sync_stripe",
            lastCheckedAt: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("shows Stripe sync copy for Stripe recovery", () => {
    const locked = me({
      subscription: {
        tier: "pro",
        status: "active",
        currentPeriodEnd: new Date().toISOString(),
        cancelAtPeriodEnd: false,
        source: "stripe",
        pendingTier: null,
        pendingTierAt: null,
      },
      billingRecovery: {
        locked: true,
        reason: "plan_mismatch",
        source: "stripe",
        action: "sync_stripe",
        lastCheckedAt: null,
      },
    });
    expect(billingRecoveryButtonLabel(locked)).toBe("Sync billing");
    expect(billingRecoveryFootnote(locked, "the App Store")).toContain("web billing");
  });

  it("shows native restore copy for IAP recovery", () => {
    const locked = me({
      subscription: {
        tier: "pro",
        status: "active",
        currentPeriodEnd: new Date().toISOString(),
        cancelAtPeriodEnd: false,
        source: "iap_apple",
        pendingTier: null,
        pendingTierAt: null,
      },
      billingRecovery: {
        locked: true,
        reason: "plan_mismatch",
        source: "iap_apple",
        action: "restore_iap",
        lastCheckedAt: null,
      },
    });
    expect(billingRecoveryButtonLabel(locked)).toBe("Restore purchases");
    expect(billingRecoveryFootnote(locked, "the App Store")).toContain("App Store handles");
  });

  it("does not label unknown-source recovery as native restore", () => {
    const locked = me({
      billingRecovery: {
        locked: true,
        reason: "plan_mismatch",
        source: null,
        action: null,
        lastCheckedAt: null,
      },
    });
    expect(billingRecoveryButtonLabel(locked)).toBe("Contact support");
    expect(billingRecoveryLockCopy(locked)).toContain("could not determine");
  });
});
```

- [ ] **Step 3: Replace restore-only handler with provider-dispatched recovery**

Replace `restoreNativeSubscription` with:

```ts
  const recoverBilling = useCallback(async () => {
    if (busy || !me) return;
    const action = me.billingRecovery?.action ?? null;
    if (!action) {
      Alert.alert(
        "Recovery unavailable",
        "We could not determine where this subscription is managed. Contact support.",
      );
      return;
    }
    setBusy("restore");
    try {
      const nextMe =
        action === "sync_stripe"
          ? await postBillingSync()
          : await restoreCurrentNativeSubscriptions();

      if (!nextMe) {
        Alert.alert(
          "No subscription found",
          `No active Fina subscription was found in ${storeName}.`,
        );
        await loadMe();
        return;
      }
      setMe(nextMe);
      if (isBillingLocked(nextMe)) {
        Alert.alert(
          "Recovery incomplete",
          "We could not confirm that this Fina account and billing provider match yet.",
        );
        return;
      }
      goHome();
    } catch (e: any) {
      Alert.alert("Recovery failed", e?.message ?? "Try again.");
      void loadMe();
    } finally {
      setBusy(null);
    }
  }, [busy, goHome, loadMe, me, storeName]);
```

- [ ] **Step 4: Update Plan screen lock branch**

Replace:

```ts
  const isPlanMismatch = me.iapIntegrity.isPlanMismatch;
```

with:

```ts
  const isPlanMismatch = isBillingLocked(me);
```

Replace the lock copy:

```tsx
              This Fina account and the subscription on this device do not match.
```

with:

```tsx
              {billingRecoveryLockCopy(me)}
```

Replace `onPress={restoreNativeSubscription}` with:

```tsx
              onPress={recoverBilling}
```

Replace the button label:

```tsx
                  <Text style={styles.restoreButtonText}>Restore purchases</Text>
```

with:

```tsx
                  <Text style={styles.restoreButtonText}>{billingRecoveryButtonLabel(me)}</Text>
```

Replace the footnote:

```tsx
          {storeName} handles payment, cancellation, and subscription changes.
```

with:

```tsx
          {billingRecoveryFootnote(me, storeName)}
```

- [ ] **Step 5: Update plan helper guards**

In `currentPlanMeta`, replace:

```ts
  if (me.iapIntegrity.isPlanMismatch) {
```

with:

```ts
  if (isBillingLocked(me)) {
```

In `planAction`, replace:

```ts
  if (me.iapIntegrity.isPlanMismatch) {
```

with:

```ts
  if (isBillingLocked(me)) {
```

- [ ] **Step 6: Run mobile recovery helper tests and typecheck**

Run:

```bash
pnpm --filter @fina/mobile exec vitest run src/billing/recovery-ui.test.ts --config vitest.config.ts
pnpm exec nx typecheck mobile
```

Expected: both commands PASS.

- [ ] **Step 7: Commit Plan screen recovery work**

Run:

```bash
git add apps/mobile/src/billing/recovery-ui.ts apps/mobile/src/billing/recovery-ui.test.ts apps/mobile/app/plan/index.tsx
git commit -m "Unify mobile billing recovery actions"
```

Expected: commit succeeds.

---

### Task 4: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run shared typecheck**

Run:

```bash
pnpm exec nx typecheck shared
```

Expected: PASS.

- [ ] **Step 2: Run API typecheck**

Run:

```bash
pnpm exec nx typecheck api
```

Expected: PASS.

- [ ] **Step 3: Run mobile typecheck**

Run:

```bash
pnpm exec nx typecheck mobile
```

Expected: PASS.

- [ ] **Step 4: Run focused API tests**

Run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec nx test api -- --run tests/me.test.ts tests/billing-sync.test.ts tests/iap/billing-iap.routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run focused mobile recovery helper tests**

Run:

```bash
pnpm --filter @fina/mobile exec vitest run src/billing/recovery-ui.test.ts --config vitest.config.ts
```

Expected: PASS.

- [ ] **Step 6: Inspect git status**

Run:

```bash
git status --short
```

Expected: only pre-existing unrelated files, if any, remain unstaged. The known pre-existing `README.md` change may still appear and should not be reverted.
