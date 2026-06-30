# Morning Brief Settings and Push Routing

Date: 2026-06-30

## User-Facing Changes

- Added a Morning brief frequency setting:
  - Needs attention: sends only when Fina finds something important.
  - Every morning: sends even on quiet days.
- Morning brief notifications now open the related Chat thread instead of landing on Home.

## Backend Changes

- Added `User.morningBriefFrequency` with a `daily` default for existing behavior.
- Updated `/me` and billing sync `MeDTO` responses to include the new setting.
- Updated daily brief cron behavior so `issues_only` users skip quiet days.
- Added `threadId` to daily brief push notification payloads.

## Mobile Changes

- Added frequency controls to the Morning brief settings screen.
- Added notification tap routing for daily brief payloads.

## Verification

- `shared:typecheck`
- `api:typecheck`
- `mobile:typecheck`
- API targeted tests: `68 passed`
- Mobile tests: `67 passed`
