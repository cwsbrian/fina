# Mobile Plan UX + Trial→Standing-Tier Downgrade Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface "Reverts to Lite on <date>" wherever the current plan is shown (web + mobile) when a Pro trial sits on top of a standing sub-Pro subscription, fix the headerless mobile plan screens, and add a "Your Plan" detail screen.

**Architecture:** Three pure `@fina/shared` helpers (`trialRevertsTo`, `subscriptionSourceLabel`, `formatShortDate`) drive presentation-only changes at four display sites plus one new mobile screen. No API/route/DB work. Per repo rule, all shared additions ship in their own commits **before** any app-side change.

**Tech Stack:** TypeScript, pnpm + Nx monorepo, vitest (shared unit tests), Next.js (web), Expo / React Native (mobile), `@fina/shared` as the source of truth.

**Spec:** `docs/superpowers/specs/2026-05-29-trial-downgrade-indicator-design.md`

**Branch:** `feat/mobile-plan-ux` (off `main`).

---

## File Structure

**Shared (`libs/shared/src/`) — ships first:**
- Create `format/date.ts` — `formatShortDate(input)`; Create `format/date.test.ts`.
- Modify `tier.ts` — add `trialRevertsTo(me)`; Create `tier.test.ts`.
- Modify `dto/subscription.ts` — add `subscriptionSourceLabel(source)`; Create `dto/subscription.test.ts`.
- Modify `index.ts` — export the new `format/date.js` (tier/subscription are already `export *`).

**Web (`apps/web/src/`):**
- Modify `app/(app)/home/page.tsx` — trial banner sub-text + button label.
- Modify `app/(app)/settings/plan/page.tsx` — `trialActive && sub` card branch.

**Mobile (`apps/mobile/`):**
- Modify `app/(tabs)/index.tsx` — home trial banner adds a revert line.
- Create `src/iap/manage.ts` — `openManageBilling(tier?)` (stateless deep-link); Modify `app/(tabs)/more.tsx` to use it + reroute the Plan row.
- Modify `app/plan/index.tsx`, `app/plan/restore.tsx` — custom header pattern.
- Create `app/plan/details.tsx` — "Your Plan" screen.

---

## Task 1: Shared — `formatShortDate`

**Files:**
- Create: `libs/shared/src/format/date.ts`
- Test: `libs/shared/src/format/date.test.ts`
- Modify: `libs/shared/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `libs/shared/src/format/date.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatShortDate } from "./date.js";

describe("formatShortDate", () => {
  it("formats a locally-constructed Date as short month + day", () => {
    // Local construction → deterministic regardless of the runner's timezone.
    expect(formatShortDate(new Date(2026, 5, 24))).toBe("Jun 24");
  });
  it("formats an ISO string consistently with the Date path", () => {
    const iso = "2026-06-24T12:00:00.000Z";
    const out = formatShortDate(iso);
    expect(out).toBe(
      new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
    expect(out).toMatch(/^[A-Za-z]{3,} \d{1,2}$/);
  });
  it("returns empty string for null / undefined / invalid", () => {
    expect(formatShortDate(null)).toBe("");
    expect(formatShortDate(undefined)).toBe("");
    expect(formatShortDate("not-a-date")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx test shared`
Expected: FAIL — `Cannot find module './date.js'` (file not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `libs/shared/src/format/date.ts`:

```ts
// Date-display helpers. Pure; safe from API logging, web UI, and mobile UI
// (RN Hermes supports Intl). Renders in the caller's local timezone — the
// intended UX for "Reverts to … on <date>" / "Next charge <date>" copy.

/** Short month + day, e.g. "Jun 24". Accepts an ISO-8601 string or a Date.
 *  Returns "" for null / undefined / unparseable input so callers can omit
 *  the trailing "on <date>" cleanly. */
export function formatShortDate(input: string | Date | null | undefined): string {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
```

- [ ] **Step 4: Export from the package index**

In `libs/shared/src/index.ts`, under the `// UI-display helpers` group (which already has `export * from "./format/identity.js";`), add:

```ts
export * from "./format/date.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm nx test shared`
Expected: PASS (all `formatShortDate` cases green).

- [ ] **Step 6: Commit**

```bash
git add libs/shared/src/format/date.ts libs/shared/src/format/date.test.ts libs/shared/src/index.ts
git commit -m "feat(shared): add formatShortDate display helper"
```

---

## Task 2: Shared — `trialRevertsTo`

**Files:**
- Modify: `libs/shared/src/tier.ts`
- Test: `libs/shared/src/tier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `libs/shared/src/tier.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { trialRevertsTo } from "./tier.js";

describe("trialRevertsTo", () => {
  it("trial + lite sub → 'lite'", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "lite", pendingTier: null } }),
    ).toBe("lite");
  });
  it("trial + pro sub → null (staying Pro is not a downgrade)", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "pro", pendingTier: null } }),
    ).toBeNull();
  });
  it("follows pendingTier when a change is scheduled (pro now, lite queued)", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "pro", pendingTier: "lite" } }),
    ).toBe("lite");
  });
  it("ignores a pendingTier equal to the current tier", () => {
    expect(
      trialRevertsTo({ trial: { active: true }, subscription: { tier: "lite", pendingTier: "lite" } }),
    ).toBe("lite");
  });
  it("trial + no sub → null", () => {
    expect(trialRevertsTo({ trial: { active: true }, subscription: null })).toBeNull();
  });
  it("no trial → null", () => {
    expect(
      trialRevertsTo({ trial: { active: false }, subscription: { tier: "lite", pendingTier: null } }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx test shared`
Expected: FAIL — `trialRevertsTo is not a function` / not exported.

- [ ] **Step 3: Write minimal implementation**

In `libs/shared/src/tier.ts`, add this import at the very top of the file (above `export const TIERS`):

```ts
import type { PaidTier } from "./pricing.js";
```

Then append at the end of the file:

```ts
/** The tier a user reverts to when their active Pro trial ends, IF they hold
 *  a standing paid subscription below Pro. Returns the sub's tier — or its
 *  scheduled pendingTier when a change is queued. Returns null when: not in a
 *  trial, no standing sub on file, or the post-trial tier is still Pro
 *  (nothing to warn about). Drives "Reverts to <Lite> on <date>" copy.
 *  Param/return are PaidTier (exactly MeDTO.subscription's shape) — a standing
 *  sub is never `free`, and the result narrows to "lite". */
export function trialRevertsTo(me: {
  trial: { active: boolean };
  subscription: { tier: PaidTier; pendingTier: PaidTier | null } | null;
}): PaidTier | null {
  if (!me.trial.active || !me.subscription) return null;
  const s = me.subscription;
  const next = s.pendingTier && s.pendingTier !== s.tier ? s.pendingTier : s.tier;
  return next === "pro" ? null : next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm nx test shared`
Expected: PASS (all six `trialRevertsTo` cases green).

- [ ] **Step 5: Commit**

```bash
git add libs/shared/src/tier.ts libs/shared/src/tier.test.ts
git commit -m "feat(shared): add trialRevertsTo tier-precedence helper"
```

---

## Task 3: Shared — `subscriptionSourceLabel`

**Files:**
- Modify: `libs/shared/src/dto/subscription.ts`
- Test: `libs/shared/src/dto/subscription.test.ts`

- [ ] **Step 1: Write the failing test**

Create `libs/shared/src/dto/subscription.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { subscriptionSourceLabel } from "./subscription.js";

describe("subscriptionSourceLabel", () => {
  it("stripe → Web", () => expect(subscriptionSourceLabel("stripe")).toBe("Web"));
  it("iap_apple → App Store", () =>
    expect(subscriptionSourceLabel("iap_apple")).toBe("App Store"));
  it("iap_google → Google Play", () =>
    expect(subscriptionSourceLabel("iap_google")).toBe("Google Play"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm nx test shared`
Expected: FAIL — `subscriptionSourceLabel is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `libs/shared/src/dto/subscription.ts`, append at the end of the file (after the `SubscriptionDTO` type):

```ts
/** User-facing label for a subscription's billing source. */
export function subscriptionSourceLabel(
  source: SubscriptionSource,
): "Web" | "App Store" | "Google Play" {
  switch (source) {
    case "stripe":
      return "Web";
    case "iap_apple":
      return "App Store";
    case "iap_google":
      return "Google Play";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm nx test shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add libs/shared/src/dto/subscription.ts libs/shared/src/dto/subscription.test.ts
git commit -m "feat(shared): add subscriptionSourceLabel display helper"
```

---

## Task 4: Web — home trial banner

**Files:**
- Modify: `apps/web/src/app/(app)/home/page.tsx` (import ~L6–13, derive ~L138, banner sub-text ~L198–200, button ~L202–208)

- [ ] **Step 1: Add the shared imports**

In the `@fina/shared` import block (currently `displayName, trialDaysLeft, type MeDTO as Me, ...`), add `tierLabel`, `trialRevertsTo`, and `formatShortDate`:

```ts
import {
  displayName,
  trialDaysLeft,
  tierLabel,
  trialRevertsTo,
  formatShortDate,
  type MeDTO as Me,
  type WorkspaceSummary as Workspace,
  type Member,
  type PlaidItemDTO,
} from "@fina/shared";
```

- [ ] **Step 2: Derive `revertsTo` alongside `days`**

Find the line `const days = me ? trialDaysLeft(me.trial.endsAt) : null;` (~L138) and add directly below it:

```ts
  const revertsTo = me ? trialRevertsTo(me) : null;
```

- [ ] **Step 3: Replace the misleading banner sub-text**

Replace the existing sub-text block:

```tsx
            <div className={styles.bannerSub}>
              Add a card to keep Pro at $15/mo when the trial ends.
            </div>
```

with:

```tsx
            <div className={styles.bannerSub}>
              {revertsTo
                ? `Reverts to ${tierLabel(revertsTo, false)} on ${formatShortDate(me?.trial.endsAt)}.`
                : "Add a card to keep Pro at $15/mo when the trial ends."}
            </div>
```

- [ ] **Step 4: Relabel the banner button (route unchanged)**

Replace the button's label `Stay on Pro` (~L207) so the button reads:

```tsx
          <button
            type="button"
            className={styles.bannerBtn}
            onClick={() => router.push("/settings/plan")}
          >
            {revertsTo ? "Manage plan" : "Stay on Pro"}
          </button>
```

- [ ] **Step 5: Typecheck**

Run: `pnpm nx typecheck web`
Expected: PASS (no type errors).

- [ ] **Step 6: Manual UI verification**

Run the web dev server (`pnpm nx dev web`). With the test account (Pro trial + Lite IAP sub) the banner reads "Reverts to Lite on <date>." and the button reads "Manage plan". With a free-trial (no-sub) account the original "Add a card…" sub-text + "Stay on Pro" button are unchanged.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/src/app/(app)/home/page.tsx"
git commit -m "feat(web): home trial banner shows revert-to-tier for sub-Pro standing subs"
```

---

## Task 5: Web — plan card (`trialActive && sub` branch)

**Files:**
- Modify: `apps/web/src/app/(app)/settings/plan/page.tsx` (imports near top; branch ~L118–151)

- [ ] **Step 1: Add the shared imports**

In this file's `@fina/shared` import, add `trialRevertsTo`, `tierLabel`, and `formatShortDate` (the file already imports `PRICING`, `trialDaysLeft`, and the `SubscriptionDTO` type).

- [ ] **Step 2: Rewrite the branch body to honour `trialRevertsTo`**

Replace the entire `if (trialActive && sub) { ... }` block (~L118–151) with:

```tsx
    if (trialActive && sub) {
      // Trial active AND a paid sub on file. `revertsTo` is non-null only when
      // the post-trial tier is below Pro (a downgrade to warn about); it
      // already folds in a scheduled pendingTier. When null, keep the existing
      // charge / scheduled-switch copy untouched.
      const revertsTo = trialRevertsTo(me);
      const upcomingTier =
        sub.pendingTier && sub.pendingTier !== sub.tier ? sub.pendingTier : sub.tier;
      const upcomingLabel = upcomingTier === "pro" ? "Pro" : "Lite";
      const upcomingPrice = PRICING[upcomingTier].displayPrice;
      const at = new Date(sub.currentPeriodEnd).toLocaleDateString();
      const hasSchedule = sub.pendingTier && sub.pendingTier !== sub.tier;
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>Pro trial</div>
            <div className={styles.planCurrentStatus}>
              {days != null ? `${days} day${days === 1 ? "" : "s"} left.` : ""}{" "}
              {revertsTo
                ? `Reverts to ${tierLabel(revertsTo, false)} on ${formatShortDate(me.trial.endsAt)}. ${upcomingPrice} will be charged.`
                : hasSchedule
                  ? `Switches to ${upcomingLabel} on ${at}. ${upcomingPrice} will be charged.`
                  : `${upcomingPrice} will be charged on ${at}.`}
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
```

- [ ] **Step 3: Typecheck**

Run: `pnpm nx typecheck web`
Expected: PASS.

- [ ] **Step 4: Manual UI verification**

On `/settings/plan` with the test account, the current-plan card reads "… N days left. Reverts to Lite on <date>. $7 will be charged." A Pro-sub-under-trial account (no downgrade) keeps the original "$15 will be charged on <date>." copy.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/src/app/(app)/settings/plan/page.tsx"
git commit -m "feat(web): plan card names the revert tier under a Pro trial"
```

---

## Task 6: Mobile — home trial banner

**Files:**
- Modify: `apps/mobile/app/(tabs)/index.tsx` (import ~L14–24, derive ~L264, banner ~L444–451, styles ~L906–917)

- [ ] **Step 1: Add the shared imports**

In the `@fina/shared` import block (currently includes `trialDaysLeft`), add `tierLabel`, `trialRevertsTo`, and `formatShortDate`.

- [ ] **Step 2: Derive `revertsTo` alongside `days`**

Find `const days = me?.trial?.endsAt ? trialDaysLeft(me.trial.endsAt) : null;` (~L264) and add below it:

```ts
  const revertsTo = me ? trialRevertsTo(me) : null;
```

- [ ] **Step 3: Wrap the banner pill and add the revert line**

Replace the banner block:

```tsx
        {me?.trial?.active && days !== null && (
          <View style={styles.trialBanner}>
            <Ionicons name="sparkles" size={16} color={colors.navy} />
            <Text style={styles.trialBannerText}>
              Pro trial · {days} day{days === 1 ? "" : "s"} left
            </Text>
          </View>
        )}
```

with:

```tsx
        {me?.trial?.active && days !== null && (
          <View style={styles.trialBannerWrap}>
            <View style={styles.trialBanner}>
              <Ionicons name="sparkles" size={16} color={colors.navy} />
              <Text style={styles.trialBannerText}>
                Pro trial · {days} day{days === 1 ? "" : "s"} left
              </Text>
            </View>
            {revertsTo && (
              <Text style={styles.trialRevertText}>
                Reverts to {tierLabel(revertsTo, false)} on {formatShortDate(me.trial.endsAt)}
              </Text>
            )}
          </View>
        )}
```

- [ ] **Step 4: Adjust styles (move bottom margin to the wrapper, add the revert text style)**

In the `StyleSheet.create({...})` block, change the `trialBanner` entry to drop its `marginBottom` and add two new entries:

```ts
  trialBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(143, 184, 232, 0.18)",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderRadius: 999,
    alignSelf: "flex-start",
  },
  trialBannerWrap: { marginBottom: space.lg },
  trialBannerText: { ...type$.captionStrong, color: colors.navy },
  trialRevertText: { ...type$.bodySm, color: colors.muted, marginTop: 6, marginLeft: 2 },
```

- [ ] **Step 5: Typecheck**

Run: `pnpm nx typecheck mobile`
Expected: PASS. (`tsc --noEmit` alone is a no-op for mobile — always use the nx target.)

- [ ] **Step 6: Manual UI verification (Expo Go is fine — no native module here)**

Home tab with the test account shows the pill "Pro trial · Nd left" with a muted "Reverts to Lite on <date>" line directly below. A free-trial (no-sub) account shows only the pill.

- [ ] **Step 7: Commit**

```bash
git add "apps/mobile/app/(tabs)/index.tsx"
git commit -m "feat(mobile): home trial banner shows revert-to-tier line"
```

---

## Task 7: Mobile — extract `openManageBilling` helper

**Files:**
- Create: `apps/mobile/src/iap/manage.ts`
- Modify: `apps/mobile/app/(tabs)/more.tsx` (`onManageBilling` ~L143–162)

- [ ] **Step 1: Create the stateless deep-link helper**

Create `apps/mobile/src/iap/manage.ts`:

```ts
import { Linking, Platform } from "react-native";
import type { PaidTier } from "@fina/shared";

/** Open the platform-native subscription-management surface (App Store on
 *  iOS, Play Store on Android). Stateless — each caller owns its own busy /
 *  spinner state and awaits this. `tier` selects the Android deep-link SKU;
 *  ignored on iOS, and on Android a missing tier just no-ops (matches the
 *  prior inline behaviour for a user with no sub on file). */
export async function openManageBilling(tier?: PaidTier): Promise<void> {
  if (Platform.OS === "ios") {
    await Linking.openURL("https://apps.apple.com/account/subscriptions");
    return;
  }
  if (Platform.OS === "android" && tier) {
    const productId = tier === "pro" ? "pro_monthly" : "lite_monthly";
    await Linking.openURL(
      `https://play.google.com/store/account/subscriptions?package=app.fina&sku=${encodeURIComponent(productId)}`,
    );
  }
}
```

> Note: the `package=app.fina` query string is preserved verbatim from the original inline code. Do not "fix" it here — any package-string change is out of scope for this plan.

- [ ] **Step 2: Refactor `more.tsx` to call the helper**

Add the import near the other `src/...` imports in `more.tsx`:

```ts
import { openManageBilling } from "../../src/iap/manage";
```

Replace the existing `onManageBilling` callback (~L143–162):

```ts
  const onManageBilling = useCallback(async () => {
    if (openingBilling) return;
    setOpeningBilling(true);
    try {
      if (Platform.OS === "ios") {
        await Linking.openURL("https://apps.apple.com/account/subscriptions");
        return;
      }
      if (Platform.OS === "android" && me?.subscription) {
        const productId =
          me.subscription.tier === "pro" ? "pro_monthly" : "lite_monthly";
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

with:

```ts
  const onManageBilling = useCallback(async () => {
    if (openingBilling) return;
    setOpeningBilling(true);
    try {
      await openManageBilling(me?.subscription?.tier);
    } finally {
      setOpeningBilling(false);
    }
  }, [openingBilling, me?.subscription]);
```

- [ ] **Step 3: Remove now-unused imports if orphaned**

`Linking` may no longer be referenced in `more.tsx`. Check:

Run: `grep -n "Linking" "apps/mobile/app/(tabs)/more.tsx"`
Expected: no matches besides the (now removed) usage. If `Linking` is unused, remove it from the `react-native` import list (~L11). Leave `Platform` if anything else still uses it (run `grep -n "Platform" "apps/mobile/app/(tabs)/more.tsx"` — if no remaining use, remove it too).

- [ ] **Step 4: Typecheck**

Run: `pnpm nx typecheck mobile`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/iap/manage.ts "apps/mobile/app/(tabs)/more.tsx"
git commit -m "refactor(mobile): extract stateless openManageBilling helper"
```

---

## Task 8: Mobile — fix headerless plan picker + restore screens

**Files:**
- Modify: `apps/mobile/app/plan/index.tsx`
- Modify: `apps/mobile/app/plan/restore.tsx`

Pattern reference: `apps/mobile/app/categories/index.tsx:60–73` (SafeAreaView + `Stack.Screen headerShown:false` + a `head` row with `HeaderIconButton icon="chevron-back"` + centered title) and its `styles.safe/head/title` (`categories/index.tsx:159–170`).

- [ ] **Step 1: Picker — add header imports**

In `app/plan/index.tsx`, extend the `react-native` import to include `StyleSheet`, add `SafeAreaView`, `HeaderIconButton`, and tokens:

```ts
import { View, Text, Pressable, ActivityIndicator, ScrollView, Alert, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack } from "expo-router";
// ...existing imports...
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
```

(The file already imports `colors` from tokens — replace that line with the combined `colors, space, type as type$` import above.)

- [ ] **Step 2: Picker — restructure the return with a custom header**

Replace the loading early-return AND the main return (everything from `if (products === null) {` through the final `);` of the component) with:

```tsx
  const body =
    products === null ? (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80 }}>
        <ActivityIndicator />
      </View>
    ) : (
      <ScrollView contentContainerStyle={{ padding: 24, gap: 16 }}>
        {products.length === 0 ? (
          <View
            style={{
              padding: 24,
              borderRadius: 12,
              backgroundColor: colors.surfaceSoft,
            }}
          >
            <Text style={{ fontSize: 16, color: colors.ink }}>
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
                borderColor: colors.hairline,
              }}
            >
              <Text style={{ fontSize: 18, fontWeight: "700", color: colors.ink }}>
                {p.localizedTitle}
              </Text>
              <Text style={{ marginTop: 4, color: colors.muted }}>
                {p.tier === "pro" ? "Unlimited" : "Lite"}
              </Text>
              <Text style={{ marginTop: 12, fontSize: 22, fontWeight: "700", color: colors.ink }}>
                {p.localizedPrice}
              </Text>
              {busy === p.productId && <ActivityIndicator style={{ marginTop: 8 }} />}
            </Pressable>
          ))
        )}
        {/* Apple Guideline 3.1.1 — Restore must be reachable from plan picker. */}
        <Pressable
          onPress={() => router.push("/plan/restore" as never)}
          style={{ marginTop: 8, alignItems: "center" }}
        >
          <Text style={{ color: colors.primary }}>Restore purchases</Text>
        </Pressable>
      </ScrollView>
    );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
        <Text style={styles.title}>Choose Plan</Text>
        <View style={{ width: 40 }} />
      </View>
      {body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
});
```

(The `width: 40` spacer balances the lone back chevron so the title stays centered, mirroring the two-button `categories` header.)

- [ ] **Step 3: Restore — add header imports**

In `app/plan/restore.tsx`, extend imports:

```ts
import { View, Text, Pressable, ActivityIndicator, Alert, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack } from "expo-router";
import { listAvailablePurchases } from "../../src/iap/client";
import { postIAPRestore } from "../../src/api/billing";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
```

- [ ] **Step 4: Restore — wrap content in SafeAreaView + header**

Replace the entire `return ( ... );` with:

```tsx
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
        <Text style={styles.title}>Restore purchases</Text>
        <View style={{ width: 40 }} />
      </View>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
        <Pressable
          onPress={onRestore}
          disabled={busy}
          style={{
            padding: 16,
            paddingHorizontal: 28,
            borderRadius: 999,
            backgroundColor: colors.primary,
          }}
        >
          {busy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={{ color: "#fff", fontWeight: "600" }}>Restore purchases</Text>
          )}
        </Pressable>
        {status && <Text style={{ marginTop: 16, color: colors.muted }}>{status}</Text>}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
});
```

- [ ] **Step 5: Typecheck**

Run: `pnpm nx typecheck mobile`
Expected: PASS.

- [ ] **Step 6: Manual UI verification (Expo Go fine)**

Open the picker (More → Plan as a free/trial-no-sub user) — it now shows a "Choose Plan" header with a working back chevron. Open Restore (from the picker link) — it shows a "Restore purchases" header.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/plan/index.tsx apps/mobile/app/plan/restore.tsx
git commit -m "fix(mobile): add custom headers to plan picker + restore screens"
```

---

## Task 9: Mobile — new "Your Plan" detail screen

**Files:**
- Create: `apps/mobile/app/plan/details.tsx`

- [ ] **Step 1: Create the screen**

Create `apps/mobile/app/plan/details.tsx`:

```tsx
import { useEffect, useState, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import {
  tierLabel,
  trialDaysLeft,
  trialRevertsTo,
  formatShortDate,
  subscriptionSourceLabel,
  PRICING,
  type MeDTO as Me,
} from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { openManageBilling } from "../../src/iap/manage";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { colors, space, type as type$ } from "../../src/design/tokens";

export default function PlanDetails() {
  const [me, setMe] = useState<Me | null>(null);
  const [openingBilling, setOpeningBilling] = useState(false);

  useEffect(() => {
    apiFetch<Me>("/me").then(setMe).catch(() => {});
  }, []);

  const onManageBilling = useCallback(async () => {
    if (openingBilling) return;
    setOpeningBilling(true);
    try {
      await openManageBilling(me?.subscription?.tier);
    } finally {
      setOpeningBilling(false);
    }
  }, [openingBilling, me?.subscription]);

  const Header = () => (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
        <Text style={styles.title}>Your Plan</Text>
        <View style={{ width: 40 }} />
      </View>
    </>
  );

  if (!me) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Header />
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const sub = me.subscription;
  const days = trialDaysLeft(me.trial.endsAt);
  const revertsTo = trialRevertsTo(me);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Header />
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Current plan</Text>
          <Text style={styles.planName}>{tierLabel(me.tier, me.trial.active)}</Text>
          {me.trial.active && days !== null && (
            <Text style={styles.planMeta}>
              {days} day{days === 1 ? "" : "s"} left
            </Text>
          )}
          {revertsTo && (
            <Text style={styles.revertText}>
              Reverts to {tierLabel(revertsTo, false)} on {formatShortDate(me.trial.endsAt)}
            </Text>
          )}
        </View>

        {sub && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>Subscription</Text>
            <Text style={styles.subTier}>
              {tierLabel(sub.tier, false)} · {PRICING[sub.tier].displayPrice}/mo
            </Text>
            <Text style={styles.subMeta}>via {subscriptionSourceLabel(sub.source)}</Text>
            <Text style={styles.subMeta}>
              {sub.cancelAtPeriodEnd
                ? `Ends on ${formatShortDate(sub.currentPeriodEnd)}`
                : `Next charge ${formatShortDate(sub.currentPeriodEnd)}`}
            </Text>
          </View>
        )}

        <View style={styles.actions}>
          {sub ? (
            <>
              <Pressable style={styles.btnPrimary} onPress={() => router.push("/plan" as never)}>
                <Text style={styles.btnPrimaryText}>Change plan</Text>
              </Pressable>
              <Pressable
                style={styles.btnOutline}
                onPress={onManageBilling}
                disabled={openingBilling}
              >
                {openingBilling ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <Text style={styles.btnOutlineText}>Manage billing</Text>
                )}
              </Pressable>
              <Pressable
                style={styles.btnGhost}
                onPress={() => router.push("/plan/restore" as never)}
              >
                <Text style={styles.btnGhostText}>Restore purchases</Text>
              </Pressable>
            </>
          ) : (
            <Pressable style={styles.btnPrimary} onPress={() => router.push("/plan" as never)}>
              <Text style={styles.btnPrimaryText}>Choose a plan</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: space.lg, gap: space.base },
  card: { backgroundColor: colors.surfaceSoft, borderRadius: 14, padding: space.lg, gap: 4 },
  cardLabel: { ...type$.bodySm, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.5 },
  planName: { ...type$.titleSm, color: colors.ink, fontWeight: "700" },
  planMeta: { ...type$.bodySm, color: colors.muted },
  revertText: { ...type$.bodySm, color: colors.navy, marginTop: 4 },
  subTier: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  subMeta: { ...type$.bodySm, color: colors.muted },
  actions: { gap: space.sm, marginTop: space.base },
  btnPrimary: { backgroundColor: colors.primary, borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  btnPrimaryText: { ...type$.bodyMd, color: "#fff", fontWeight: "600" },
  btnOutline: { borderWidth: 1, borderColor: colors.hairline, borderRadius: 999, paddingVertical: 14, alignItems: "center" },
  btnOutlineText: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  btnGhost: { paddingVertical: 12, alignItems: "center" },
  btnGhostText: { ...type$.bodyMd, color: colors.primary },
});
```

- [ ] **Step 2: Verify token names compile**

Run: `pnpm nx typecheck mobile`
Expected: PASS. If any token (`colors.navy`, `colors.hairline`, `colors.surfaceSoft`, `type$.bodyMd/bodySm/titleSm`) is reported missing, open `apps/mobile/src/design/tokens.ts` and substitute the nearest existing token (these are all used elsewhere in the app, so they should resolve).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/plan/details.tsx
git commit -m "feat(mobile): add Your Plan detail screen"
```

---

## Task 10: Mobile — route More → Plan to the detail screen

**Files:**
- Modify: `apps/mobile/app/(tabs)/more.tsx` (Plan-row `onPress` ~L394–400; `comingSoon` def ~L164–165)

- [ ] **Step 1: Reroute the IAP-sub branch of the Plan row**

Replace the Plan row's `onPress` (~L394–400):

```tsx
                  onPress={
                    isStripeOwned
                      ? () => onStripeManagedTap("Plan")
                      : me?.subscription
                        ? comingSoon("Plan details")
                        : () => router.push("/plan" as never)
                  }
```

with:

```tsx
                  onPress={
                    isStripeOwned
                      ? () => onStripeManagedTap("Plan")
                      : me?.subscription
                        ? () => router.push("/plan/details" as never)
                        : () => router.push("/plan" as never)
                  }
```

- [ ] **Step 2: Remove `comingSoon` if now unused**

Run: `grep -n "comingSoon" "apps/mobile/app/(tabs)/more.tsx"`
If the only remaining match is its definition (~L164–165), delete the definition:

```tsx
  const comingSoon = (label: string) => () =>
    Alert.alert("Coming soon", `${label} screen is on the way.`);
```

Then check whether `Alert` is still used elsewhere (`grep -n "Alert" "apps/mobile/app/(tabs)/more.tsx"` — sign-out + Stripe-managed taps still use it, so leave `Alert` imported).

- [ ] **Step 3: Typecheck**

Run: `pnpm nx typecheck mobile`
Expected: PASS (no unused-symbol error for `comingSoon`).

- [ ] **Step 4: Manual UI verification (requires a dev/preview build for an IAP sub — Expo Go can verify free/trial + Stripe routing only)**

- IAP-sub account: More → Plan opens the "Your Plan" screen (no more "Coming soon" alert).
- free / trial-no-sub account: More → Plan opens the picker.
- Stripe-sub account: More → Plan still shows the "managed on withfina.com" alert.

- [ ] **Step 5: Commit**

```bash
git add "apps/mobile/app/(tabs)/more.tsx"
git commit -m "feat(mobile): More plan row opens Your Plan screen for IAP subs"
```

---

## Task 11: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Shared unit tests**

Run: `pnpm nx test shared`
Expected: PASS — including the new `formatShortDate`, `trialRevertsTo`, and `subscriptionSourceLabel` specs.

- [ ] **Step 2: Typecheck all three projects**

Run: `pnpm nx run-many -t typecheck -p shared web mobile`
Expected: PASS for all three.

- [ ] **Step 3: End-to-end manual checklist** (per the repo UI rule)

With the test account (Pro trial + Lite IAP sub) confirm "Reverts to Lite on <date>" appears on: web home banner, web `/settings/plan` card, mobile home banner, and the mobile "Your Plan" screen. Confirm the mobile profile pill (`more.tsx` ~L205–210) and the More → Plan row detail stay compact (label only — no revert text crammed in). Confirm a free-trial (no-sub) account still shows the original "Add a card…" upsell banners.

- [ ] **Step 4: Final no-op commit check**

Run: `git status` — expect a clean tree (everything committed across Tasks 1–10).

---

## Self-Review Notes (author)

- **Spec coverage:** site #1 (web banner) → Task 4; site #2 (web plan card) → Task 5; site #3 (mobile banner) → Task 6; site #4 (Your Plan screen) → Task 9; header fix → Task 8; More routing → Task 10; the three shared helpers → Tasks 1–3; "pills/More row stay compact" → enforced by Tasks 6/10 leaving those untouched + verified in Task 11.
- **Type consistency:** `trialRevertsTo` returns `PaidTier | null`; every consumer feeds it to `tierLabel(revertsTo, false)` (accepts `Tier ⊇ PaidTier`). `openManageBilling(tier?: PaidTier)` is called with `me?.subscription?.tier` (`PaidTier | undefined`) at both call sites (Task 7 More, Task 9 details).
- **Out of scope (unchanged):** free-trial → Free upsell funnel; annual-plan period dimension; any API/DB/precedence change; the Android `package=app.fina` deep-link string (preserved verbatim).
