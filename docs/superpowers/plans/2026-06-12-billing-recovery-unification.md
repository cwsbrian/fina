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
- Modify `apps/api/src/routes/billing-iap.ts`: existing restore/checkout responses should receive `billingRecovery` through `buildMeBody`.
- Modify `apps/mobile/src/api/billing.ts`: add `postBillingSync`.
- Modify `apps/mobile/src/iap/sync.ts`: keep native integrity checks but consume `billingRecovery` for lock decisions.
- Modify `apps/mobile/app/(tabs)/index.tsx` and `apps/mobile/app/(tabs)/more.tsx`: route locked users using `billingRecovery.locked`.
- Modify `apps/mobile/app/plan/index.tsx`: one recovery function that dispatches `restore_iap` or `sync_stripe`.
- Test `apps/api/tests/billing-sync.test.ts`: Stripe recovery state and clearing behavior.
- Test `apps/api/tests/iap/billing-iap.routes.test.ts`: Apple/Google recovery state mapping.

---

### Task 1: Shared DTO and Server Recovery Mapper

**Files:**
- Modify: `libs/shared/src/dto/me.ts`
- Create: `apps/api/src/billing/recovery.ts`
- Modify: `apps/api/src/routes/me.ts`
- Modify: `apps/api/src/routes/billing.ts`
- Test: `apps/api/tests/billing-sync.test.ts`
- Test: `apps/api/tests/iap/billing-iap.routes.test.ts`

- [ ] **Step 1: Write failing API expectations**

Add these assertions to existing tests before implementation.

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
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec nx test api -- --run apps/api/tests/billing-sync.test.ts apps/api/tests/iap/billing-iap.routes.test.ts
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

In `apps/api/src/routes/billing.ts`, inside `POST /billing/sync`, track whether any Stripe subscription synced:

```ts
      let syncedAnyStripeSubscription = false;
```

Set it to true in both places where `syncSubscriptionFromStripe` returns a row:

```ts
          if (synced) {
            syncedAnyStripeSubscription = true;
            await reconcilePlaidItemsForUser(app.fina.env, user.id);
          }
```

After Path B finishes and before `return await buildMeBody(...)`, add a primary-source check and clear the lock only when the synced state now points at Stripe:

```ts
      if (syncedAnyStripeSubscription) {
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
        if (primaryAfterStripeSync?.source === "stripe") {
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
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec nx test api -- --run apps/api/tests/billing-sync.test.ts apps/api/tests/iap/billing-iap.routes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit server contract work**

Run:

```bash
git add libs/shared/src/dto/me.ts apps/api/src/billing/recovery.ts apps/api/src/routes/me.ts apps/api/src/routes/billing.ts apps/api/tests/billing-sync.test.ts apps/api/tests/iap/billing-iap.routes.test.ts
git commit -m "Add unified billing recovery state"
```

Expected: commit succeeds.

---

### Task 2: Mobile Billing Sync Client and Lock Routing

**Files:**
- Modify: `apps/mobile/src/api/billing.ts`
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

- [ ] **Step 2: Move mobile lock decision to `billingRecovery`**

In `apps/mobile/src/iap/sync.ts`, keep `shouldCheckNativeIntegrity` native-only, but add:

```ts
function isBillingLocked(me: MeDTO): boolean {
  return me.billingRecovery?.locked ?? me.iapIntegrity.isPlanMismatch;
}
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
      if (meData.billingRecovery?.locked ?? meData.iapIntegrity.isPlanMismatch) {
        router.replace("/plan" as never);
        return;
      }
```

In `apps/mobile/app/(tabs)/more.tsx`, replace:

```ts
        if (nextMe.iapIntegrity.isPlanMismatch) router.push("/plan" as never);
```

with:

```ts
        if (nextMe.billingRecovery?.locked ?? nextMe.iapIntegrity.isPlanMismatch) {
          router.push("/plan" as never);
        }
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
git add apps/mobile/src/api/billing.ts apps/mobile/src/iap/sync.ts 'apps/mobile/app/(tabs)/index.tsx' 'apps/mobile/app/(tabs)/more.tsx'
git commit -m "Use billing recovery for mobile lock routing"
```

Expected: commit succeeds.

---

### Task 3: Unified Plan Screen Recovery Action

**Files:**
- Modify: `apps/mobile/app/plan/index.tsx`

- [ ] **Step 1: Import Stripe sync client**

In `apps/mobile/app/plan/index.tsx`, add:

```ts
import { postBillingSync } from "../../src/api/billing";
```

- [ ] **Step 2: Add shared lock helper**

Near existing helper functions in `apps/mobile/app/plan/index.tsx`, add:

```ts
function billingLocked(me: Me): boolean {
  return me.billingRecovery?.locked ?? me.iapIntegrity.isPlanMismatch;
}

function recoveryButtonLabel(me: Me): string {
  if (me.billingRecovery?.action === "sync_stripe") return "Sync billing";
  return "Restore purchases";
}
```

- [ ] **Step 3: Replace restore-only handler with provider-dispatched recovery**

Replace `restoreNativeSubscription` with:

```ts
  const recoverBilling = useCallback(async () => {
    if (busy || !me) return;
    const action = me.billingRecovery?.action ?? "restore_iap";
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
      if (billingLocked(nextMe)) {
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
  const isPlanMismatch = billingLocked(me);
```

Replace the lock copy:

```tsx
              This Fina account and the subscription on this device do not match.
```

with:

```tsx
              This Fina account and your billing provider do not match.
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
                  <Text style={styles.restoreButtonText}>{recoveryButtonLabel(me)}</Text>
```

- [ ] **Step 5: Update plan helper guards**

In `currentPlanMeta`, replace:

```ts
  if (me.iapIntegrity.isPlanMismatch) {
```

with:

```ts
  if (billingLocked(me)) {
```

In `planAction`, replace:

```ts
  if (me.iapIntegrity.isPlanMismatch) {
```

with:

```ts
  if (billingLocked(me)) {
```

- [ ] **Step 6: Run mobile typecheck**

Run:

```bash
pnpm exec nx typecheck mobile
```

Expected: PASS.

- [ ] **Step 7: Commit Plan screen recovery work**

Run:

```bash
git add apps/mobile/app/plan/index.tsx
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
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec nx test api -- --run apps/api/tests/billing-sync.test.ts apps/api/tests/iap/billing-iap.routes.test.ts
```

Expected: PASS.

- [ ] **Step 5: Inspect git status**

Run:

```bash
git status --short
```

Expected: only pre-existing unrelated files, if any, remain unstaged. The known pre-existing `README.md` change may still appear and should not be reverted.
