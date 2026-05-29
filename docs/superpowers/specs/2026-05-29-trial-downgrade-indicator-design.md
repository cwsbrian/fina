# Trial → standing-tier downgrade indicator — design

**Date:** 2026-05-29
**Status:** Approved (brainstorming)

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
| `libs/shared/src/tier.ts` | `trialRevertsTo(me)` | `(me: { trial: { active: boolean }; subscription: { tier: Tier; pendingTier: Tier \| null } \| null }) => Tier \| null` | Single source for the "what tier do I land on after the trial" derivation. 4+ consumers across web + mobile; the codebase already routes all tier-precedence logic through `@fina/shared` and the UI never recomputes it. |

Export from `libs/shared/src/index.ts` alongside the other `tier.ts`
exports.

**No new DTO, schema, error code, or constant.** The required data
(`trial.active`, `trial.endsAt`, `subscription.tier`,
`subscription.pendingTier`) already ships on `MeDTO`. **No API change.**

## Architecture

Pure presentation change driven by one shared pure function. No
server/route/DB work.

### `trialRevertsTo`

```ts
/** The tier the user reverts to when their active Pro trial ends, IF they
 *  hold a standing paid subscription below Pro. Returns the sub's tier — or
 *  its scheduled pendingTier when a change is queued. Returns null when:
 *  not in a trial, no standing sub on file, or the post-trial tier is still
 *  Pro (nothing to warn about). Drives "Reverts to <Lite> on <date>" copy. */
export function trialRevertsTo(me: {
  trial: { active: boolean };
  subscription: { tier: Tier; pendingTier: Tier | null } | null;
}): Tier | null {
  if (!me.trial.active || !me.subscription) return null;
  const s = me.subscription;
  const next = s.pendingTier && s.pendingTier !== s.tier ? s.pendingTier : s.tier;
  return next === "pro" ? null : next;
}
```

The `pendingTier` branch mirrors the existing `upcomingTier` derivation
already inlined in `settings/plan/page.tsx` (so a scheduled
downgrade-at-period-end is reflected). `SubscriptionDTO.tier` /
`pendingTier` are `PaidTier`, assignable to `Tier`, so passing a
`MeDTO` shape compiles without coercion.

### Display sites

Each site computes `const revertsTo = trialRevertsTo(me)` and renders the
extra copy only when it is non-null. Date formatted to match the approved
preview: short month + day.

- Web: `new Date(me.trial.endsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })`
- Mobile: same `toLocaleDateString` options (RN Hermes supports Intl).

Label: `tierLabel(revertsTo, false)` → `"Lite"`.

| # | Site | File / anchor | Change |
|---|---|---|---|
| 1 | Web home trial banner | `apps/web/src/app/(app)/home/page.tsx` (~L188–210) | When `revertsTo` set: add a line "Reverts to {label} on {date}" and **replace** the "Add a card to keep Pro at $15/mo…" CTA with a "Manage plan" link to `/settings/plan`. When `revertsTo` is null (no sub): banner unchanged. |
| 2 | Web plan card (`trialActive && sub`) | `apps/web/src/app/(app)/settings/plan/page.tsx` (~L118–151) | Branch on `trialRevertsTo(me)`: when non-null (downgrade) → "Reverts to {label} on {date}. {price} will be charged." (today it says only "{price} will be charged on {date}"). When null (Pro sub under trial — no downgrade) → keep the existing "{price} will be charged on {date}" copy unchanged. The branch's existing `upcomingLabel`/`upcomingPrice` locals supply label and price. |
| 3 | Mobile home trial banner | `apps/mobile/app/(tabs)/index.tsx` (~L444–451) | Add a second line "Reverts to {label} on {date}" below "Pro trial · Nd left" when `revertsTo` set. |
| 4 | Mobile More → Plan row | `apps/mobile/app/(tabs)/more.tsx` (~L390–401, row detail ~L393) | Row detail becomes "Pro trial · reverts to {label} on {date}" when `revertsTo` set; otherwise the existing `tierLabel(...)`. |
| — | Web top-nav pill | `apps/web/src/components/AppShell.tsx` (~L134–146) | **No change** (decision: pills stay legible). |
| — | Mobile profile pill | `apps/mobile/app/(tabs)/more.tsx` (~L205–210) | **No change.** |

## Data flow

`GET /me` → `MeDTO` (unchanged) → each display component calls
`trialRevertsTo(me)` → renders the conditional copy. No new network or
state.

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

- **Unit (`libs/shared`)**: add a `trialRevertsTo` spec covering: trial+lite
  sub → `"lite"`; trial+pro sub → `null`; trial+lite sub with
  `pendingTier:"lite"`-after-pro edge → follows pendingTier; trial+no sub
  → `null`; no trial → `null`. (Use the existing shared test runner if
  present; otherwise colocate a minimal vitest spec.)
- **Manual UI verification** (per the repo UI rule): with the test
  account (Pro trial + Lite IAP sub), confirm copy appears on web home
  banner, web plan card, mobile home banner, and mobile More plan row,
  and that the small pills are unchanged. Confirm a free-trial (no-sub)
  account still shows the original upsell banners.
- `nx typecheck mobile` + web/shared typecheck must pass (bare
  `tsc --noEmit` is a no-op for mobile — see project note).

## Out of scope

- Free-trial → Free upsell copy (unchanged).
- Annual plan period dimension (separate deferred initiative).
- Any API / DB / precedence change.
