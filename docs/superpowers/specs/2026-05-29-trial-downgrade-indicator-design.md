# Mobile plan UX + trial → standing-tier downgrade indicator — design

**Date:** 2026-05-29
**Status:** Approved (brainstorming)

This spec covers three cohesive pieces of plan UX, agreed in one
brainstorming pass:

1. **Trial → standing-tier downgrade indicator** (web + mobile) — surface
   "Reverts to Lite on <date>" wherever the current plan shows.
2. **Mobile plan-screen headers** — the plan picker / restore screens have
   no visible header (root Stack disables native headers); add the app's
   custom header row, with the picker titled "Choose Plan".
3. **New mobile "Your Plan" detail screen** — More → Plan currently shows a
   "Coming soon" alert for users with an IAP sub; replace it with a screen
   that shows the active plan (incl. the downgrade indicator) and a
   change-plan action.

## Goal

When a user is on a Pro trial **and** holds a standing paid subscription
below Pro (e.g. a Lite IAP sub purchased while the trial is still
running), the UI today shows only `Pro trial · Nd` everywhere. Nothing
tells them that when the trial ends they will **revert to Lite**, not
stay on Pro. Worse, the web home trial banner actively says *"Add a card
to keep Pro at $15/mo when the trial ends"* — misleading for a user who
already has a card and a sub on file.

Surface, everywhere the current plan is displayed (with room), that the
account reverts to its standing paid tier when the Pro trial ends. Copy
form (approved): **"Reverts to Lite on Jun 24"** — tier name + short
date.

This is the exact state of the test account `brian.choi@onikon.com`
after the 2026-05-28 IAP work: active Pro trial (`trialEndsAt` in the
future) layered over an `active` `iap_google` **Lite** subscription. Pro
trial outranks Lite in `computeEffectiveTier` (correct precedence), so
`me.tier === "pro"` while `me.subscription.tier === "lite"`.

## Shared library touchpoints

### Uses (existing `@fina/shared` exports)

- `Tier` and `tierLabel(tier, trialActive)` — `libs/shared/src/tier.ts`
- `trialDaysLeft(endsAt)` — same file (already drives "N days left")
- `MeDTO` / `MeDTO.trial` / `MeDTO.subscription` — `libs/shared/src/dto/me.ts`
- `SubscriptionDTO` (`tier`, `pendingTier`) — `libs/shared/src/dto/subscription.ts`
- `PRICING[tier].displayPrice` — used by the web plan card copy

### Creates

| Target file | Export | Shape | Motivation |
|---|---|---|---|
| `libs/shared/src/tier.ts` | `trialRevertsTo(me)` | `(me: { trial: { active: boolean }; subscription: { tier: PaidTier; pendingTier: PaidTier \| null } \| null }) => PaidTier \| null` | Single source for the "what tier do I land on after the trial" derivation. 4+ consumers across web + mobile; the codebase already routes all tier-precedence logic through `@fina/shared` and the UI never recomputes it. Param/return are `PaidTier` (not `Tier`) — `SubscriptionDTO.tier`/`pendingTier` are `PaidTier`, and a standing sub is never `free`, so the input is exactly `MeDTO.subscription` with no widening. |
| `libs/shared/src/dto/subscription.ts` | `subscriptionSourceLabel(source)` | `(source: SubscriptionSource) => "Web" \| "App Store" \| "Google Play"` | User-facing label for `SubscriptionSource`. UI display helper (repo convention shares these even at 1 consumer, like identity/tier helpers); the Your Plan screen shows it, and the web plan page is a likely second consumer. |
| `libs/shared/src/format/identity.ts` (or new `format/date.ts`) | `formatShortDate(input)` | `(input: string \| Date) => string` | Renders the approved short month+day form (`{ month: "short", day: "numeric" }`, e.g. "Jun 24") used by every new "Reverts to … on <date>" / "Next charge <date>" string this feature adds (4+ new sites across web + mobile). The same format literal is already hand-inlined in `apps/mobile/src/goals/meta.ts`, `format/money.ts`, etc. — share it now for the new sites; migrating the pre-existing inlines is out of scope. |

Export all three from `libs/shared/src/index.ts` alongside the existing
`tier.ts` / `dto/subscription.ts` / `format/identity.ts` exports.

**No new DTO, schema, error code, or constant.** The required data
(`trial.active`, `trial.endsAt`, `subscription.tier`,
`subscription.pendingTier`) already ships on `MeDTO`. **No API change.**

## Architecture

Pure presentation change driven by three shared pure helpers
(`trialRevertsTo`, `subscriptionSourceLabel`, `formatShortDate`) plus one
new mobile screen. No server/route/DB work.

### `trialRevertsTo`

```ts
/** The tier the user reverts to when their active Pro trial ends, IF they
 *  hold a standing paid subscription below Pro. Returns the sub's tier — or
 *  its scheduled pendingTier when a change is queued. Returns null when:
 *  not in a trial, no standing sub on file, or the post-trial tier is still
 *  Pro (nothing to warn about). Drives "Reverts to <Lite> on <date>" copy. */
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

The `pendingTier` branch mirrors the existing `upcomingTier` derivation
already inlined in `settings/plan/page.tsx` (so a scheduled
downgrade-at-period-end is reflected). Param and return are `PaidTier`,
matching `SubscriptionDTO.tier`/`pendingTier` exactly — a standing sub is
never `free`, so `MeDTO.subscription` passes with no widening or coercion,
and the return narrows cleanly to `"lite"` (the only non-`pro` `PaidTier`).
`tierLabel`/`PRICING` accept `PaidTier` (it's a subset of `Tier`), so the
result feeds the display helpers directly.

### Display sites

Each site computes `const revertsTo = trialRevertsTo(me)` and renders the
extra copy only when it is non-null. Date is rendered with the shared
`formatShortDate(me.trial.endsAt)` (short month + day, e.g. "Jun 24") on
both web and mobile — RN Hermes supports `Intl`, so one helper serves both.

Label: `tierLabel(revertsTo, false)` → `"Lite"`.

| # | Site | File / anchor | Change |
|---|---|---|---|
| 1 | Web home trial banner | `apps/web/src/app/(app)/home/page.tsx` (sub-text ~L199, button ~L205–207) | When `revertsTo` set, two distinct edits: **(a)** replace the misleading sub-text line at ~L199 ("Add a card to keep Pro at $15/mo when the trial ends.") with "Reverts to {label} on {date}."; **(b)** relabel the ~L207 button from "Stay on Pro" to "Manage plan" (its `/settings/plan` route at ~L205 is already correct — only the label changes). When `revertsTo` is null (free-trial, no sub): both the sub-text and the "Stay on Pro" button are **unchanged** (that conversion funnel is out of scope). |
| 2 | Web plan card (`trialActive && sub`) | `apps/web/src/app/(app)/settings/plan/page.tsx` (~L118–151) | Branch on `trialRevertsTo(me)`: when non-null (downgrade) → "Reverts to {label} on {date}. {price} will be charged." (today it says only "{price} will be charged on {date}"). When null (Pro sub under trial — no downgrade) → keep the existing "{price} will be charged on {date}" copy unchanged. The branch's existing `upcomingLabel`/`upcomingPrice` locals supply label and price. |
| 3 | Mobile home trial banner | `apps/mobile/app/(tabs)/index.tsx` (~L444–451) | Add a second line "Reverts to {label} on {date}" below "Pro trial · Nd left" when `revertsTo` set. |
| 4 | Mobile "Your Plan" screen | `apps/mobile/app/plan/details.tsx` (new — see below) | Shows "Reverts to {label} on {date}" prominently when `revertsTo` set. This is the primary mobile surface for the full revert detail. |
| — | Mobile More → Plan row | `apps/mobile/app/(tabs)/more.tsx` (~L390–401, row detail ~L393) | **Stays compact** — row detail keeps `tierLabel(...)` only. The row now navigates to the Your Plan screen, which carries the revert detail. (Reconciliation decision: don't crowd the row.) |
| — | Web top-nav pill | `apps/web/src/components/AppShell.tsx` (~L134–146) | **No change** (decision: pills stay legible). |
| — | Mobile profile pill | `apps/mobile/app/(tabs)/more.tsx` (~L205–210) | **No change.** |

## Data flow

`GET /me` → `MeDTO` (unchanged) → each display component calls
`trialRevertsTo(me)` → renders the conditional copy. No new network or
state.

## Mobile plan screens

### Header bug + fix

`app/_layout.tsx:55` renders `<Stack screenOptions={{ headerShown: false }} />`,
so the native header is off app-wide. Every sub-screen that shows a header
renders its **own** header row instead — `<Stack.Screen options={{ headerShown:
false }} />` plus a `SafeAreaView` containing a back chevron
(`HeaderIconButton icon="chevron-back" variant="plain"`) and a title `<Text>`
(canonical example: `app/categories/index.tsx:62–65`).

`plan/index.tsx` and `plan/restore.tsx` instead pass `options={{ title }}`
to the dead native header, so they show **no header**. Fix both to the
custom-header pattern; the new detail screen uses it too:

| Screen | Title |
|---|---|
| `app/plan/index.tsx` | **Choose Plan** |
| `app/plan/restore.tsx` | Restore purchases |
| `app/plan/details.tsx` (new) | **Your Plan** |

Wrap each screen's content in `SafeAreaView` (`react-native-safe-area-context`)
+ the header row, matching the surrounding screens' styles.

### New screen: `app/plan/details.tsx` ("Your Plan")

A read-mostly status screen for the user's current plan. Loads `me` via
`apiFetch<MeDTO>("/me")` (same as the picker). Sections:

1. **Current plan header**: `tierLabel(me.tier, me.trial.active)` as the
   headline. When `me.trial.active`: a line "N days left"
   (`trialDaysLeft`), and when `trialRevertsTo(me)` is non-null,
   "Reverts to {tierLabel(revertsTo,false)} on {date}".
2. **Standing subscription block** (when `me.subscription`):
   - tier + price (`PRICING[sub.tier].displayPrice`),
   - source label via `subscriptionSourceLabel(sub.source)`,
   - next charge: "Next charge {date}" from `currentPeriodEnd`, or
     "Ends on {date}" when `cancelAtPeriodEnd` — both via
     `formatShortDate`.
3. **Actions**:
   - **Change plan** → `router.push("/plan")` (the picker; upgrade/switch
     uses the existing purchase flow unchanged).
   - **Manage billing** → the existing platform deep-link logic currently
     inlined as `onManageBilling` in more.tsx. Extract **only the async
     deep-link work** (open the App Store / Play subscription URL; the
     `Linking` call + error alert) into a stateless helper (e.g.
     `openManageBilling()` in `src/iap/manage.ts`). The `openingBilling`
     busy flag + its `ActivityIndicator` stay **per-screen React state** —
     each caller owns its own `useState`/spinner and `await`s the helper.
     The helper must not own or close over any React state, so More and the
     Your Plan screen don't fight over a shared spinner.
   - **Restore purchases** → `router.push("/plan/restore")`.
   - Defensive no-sub state: if the screen is opened with no
     `me.subscription` (More routes those users straight to the picker, so
     this is just a safety fallback), show a "Choose a plan" CTA → `/plan`.

The screen handles only **non-Stripe** subs. Stripe-owned subs keep their
existing "managed on withfina.com" alert in More and never route here (web
is the source of truth for Stripe — established pattern).

### More → Plan routing change

`app/(tabs)/more.tsx:394–400` Plan-row `onPress`. The row's `onPress` is a
ternary that selects a **handler function**, so the replacement must be the
deferred form `() => router.push("/plan/details")` — not a bare
`router.push(...)` (which would navigate on every render). This mirrors how
the existing `comingSoon("Plan details")` already returns a `() => Alert(...)`
thunk.

| Sub state | Today | After |
|---|---|---|
| Stripe-owned | `onStripeManagedTap` | unchanged |
| IAP sub on file | `comingSoon("Plan details")` | `() => router.push("/plan/details")` |
| free / trial, no sub | `() => router.push("/plan")` | unchanged (picker) |

## Error handling / edge cases

- **Trial + Pro sub** → `next === "pro"` → returns `null` → no extra
  copy (they stay Pro; not a downgrade).
- **Trial + no sub (free-revert)** → returns `null` → the existing
  free-trial upsell banners ("Add a card to keep Pro") are **unchanged
  and out of scope**. (We are not reworking the conversion funnel here.)
- **Scheduled change (`pendingTier`) under trial** → helper follows
  `pendingTier`, so the label reflects the queued tier.
- **No trial (plain paid sub, past_due, cancelAtPeriodEnd, free)** →
  `trial.active` false → `null`; all existing plan-card branches
  unchanged.
- **`trial.endsAt` null while `trial.active` true** → shouldn't happen
  (API sets them together), but date render guards on `endsAt` and omits
  the "on {date}" tail if missing.

## Testing

- **Unit (`libs/shared`)**: colocated vitest `*.test.ts` files (the
  established pattern — see `src/iap/productIds.test.ts`). Add a
  `trialRevertsTo` spec covering: trial+lite sub → `"lite"`; trial+pro sub →
  `null`; trial+lite sub with `pendingTier:"lite"`-after-pro edge → follows
  pendingTier; trial+no sub → `null`; no trial → `null`. Add a
  `subscriptionSourceLabel` spec (one assertion per source) and a
  `formatShortDate` spec (string + Date input → "Jun 24").
- **Manual UI verification** (per the repo UI rule): with the test
  account (Pro trial + Lite IAP sub), confirm the "Reverts to Lite on
  <date>" copy appears on web home banner, web plan card, mobile home
  banner, and the new mobile Your Plan screen, and that the small pills /
  More row stay compact. Confirm a free-trial (no-sub) account still shows
  the original upsell banners.
- **Mobile screens**: confirm the picker shows a "Choose Plan" header and
  restore shows its header (regression of the headerless bug); confirm
  More → Plan opens the Your Plan screen for an IAP sub (no more "Coming
  soon"), routes to the picker for a free/trial-no-sub account, and still
  alerts for a Stripe sub; confirm Change plan / Manage billing / Restore
  actions navigate correctly.
- `nx typecheck mobile` + web/shared typecheck must pass (bare
  `tsc --noEmit` is a no-op for mobile — see project note).

## Out of scope

- Free-trial → Free upsell copy (unchanged).
- Annual plan period dimension (separate deferred initiative).
- Any API / DB / precedence change.
