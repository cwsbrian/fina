# Plan 1U-failstop-fix-and-coverage Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1T (notifyTransactionAdded + payload shape). Closes R2 cross-cutting review follow-ups #1 (fail-stop bug), #2 (factories extraction), #3 (remaining 7 wrappers payload-shape).

## 1. Goal & scope

R1 + R2 cross-cutting reviews after Plan 1T flagged 3 follow-ups. Plan 1U bundles all three:

1. **Production fix — per-recipient try/catch in 3 fan-out helpers**:
   - `apps/api/src/push/transaction-added.ts:21-41` — outer try wraps entire for-loop
   - `apps/api/src/push/anomaly.ts:31-101` — outer try wraps entire function (including fan-out loop)
   - `apps/api/src/cron/jobs/goal-milestones.ts:29-59` — outer try wraps per-goal body (including fan-out loop)

   Each helper currently has fail-stop semantics: a single push throw halts the rest of the fan-out. R2 flagged: "Transient DB errors silently drop tail members from the fan-out."

   Fix: add inner try/catch around `await sendXxxPush(...)` calls. Errors logged per-recipient but iteration continues.

2. **Test contract updates** (2 tests):
   - `tests/push.transaction-added.test.ts` test 5 — `toHaveBeenCalledTimes(1)` → `2` (first member's push throws, catch contains it, second member still attempted).
   - `tests/cron.goal-milestones.test.ts` test 9 — `[null, 100]` → `[100, 100]` (both goals' updates fire because per-recipient catch prevents goal-level skip). Update LEAD assertion accordingly.

3. **Helper extraction — `apps/api/tests/helpers/factories.ts` (NEW)**:
   - `createTestUser(prefix?)` → `string` (returns userId)
   - `setupWorkspaceWithRoles(roles, prefix?)` → `{wsId, userIds: string[]}`
   - `makeUserWithDevices(tokens, notificationPrefs?)` → `{userId, deviceIds: string[]}` (extracted from `push.send.test.ts:31-51`)
   - `createTestCategory(wsId, name?)` → `string`

   Migrate ONLY the new test files (1Q-1T era) to use the helpers. Older files stay until next touch.

4. **Payload-shape tests for 7 remaining wrappers** (~21 tests):
   - `sendBriefPush` — title `"Fina ☀️"`, body matches param, dataType `"daily-brief"` (1 test, simplest)
   - `sendBankReconnectPush` — title `"Reconnect your bank"`, body `"${institutionName} stopped syncing..."`, dataType `"bank-reconnect"` (1 test)
   - `sendTrialExpiringPush` — daysLeft=1 → title `"Your trial ends tomorrow"`; daysLeft≥2 → title `"Your trial ends in N days"`; dataType `"trial-expiring"` (2 tests for both branches)
   - `sendGoalMilestonePush` — pct=100 → title `"Goal complete: ${title}"` + body `"Nice. Open Fina to see what's next."`; pct<100 → title `"${pct}% there on ${title}"` + body `"Keep going. Tap to see what's funding it."`; dataType `"goal-milestone"` (2 tests)
   - `sendLargeChargePush` — title `"Unusual charge: $${amount}"`, body with/without category (2 tests)
   - `sendProductUpdatePush` — title/body passthrough, dataType `"product-update"` (1 test)
   - `sendWorkspaceInvitePush` — title `"Workspace invite"`, body `"${inviterName} invited you to ${workspaceName}."`, dataType `"workspace-invite"` (1 test)

   Also: extract `getFirstPushMessage(spy)` helper to dedupe the chunk-indexing pattern (4 lines × 7+ tests).

**Out of scope:**
- E2E test through real Expo SDK (would require staging credentials).
- Plaid integration tests (`daily-refresh.ts:108`, `webhook-item.ts:35`) — separate Plan 1V candidate.
- `scheduled-spend-match` cron behavior — separate Plan.

## 2. Shared library touchpoints

**없음.** No `@fina/shared` exports change.

## 3. Production changes

**3 source files modified.** All edits are surgical — wrap one `await ...Push()` line in try/catch.

### `apps/api/src/push/transaction-added.ts`

```ts
// Before (lines 26-34):
for (const m of members) {
  if (args.excludeUserId && m.userId === args.excludeUserId) continue;
  await sendTransactionAddedPush(env, m.userId, args.merchant, args.amount.toFixed(2), args.categoryName);
}

// After:
for (const m of members) {
  if (args.excludeUserId && m.userId === args.excludeUserId) continue;
  try {
    await sendTransactionAddedPush(env, m.userId, args.merchant, args.amount.toFixed(2), args.categoryName);
  } catch (err) {
    logError({ workspaceId: args.workspaceId, recipientUserId: m.userId, err }, "transaction-added push to recipient failed");
  }
}
```

### `apps/api/src/push/anomaly.ts`

```ts
// Before (lines 87-95):
for (const m of memberships) {
  await sendLargeChargePush(env, m.userId, args.merchant ?? "An unusual charge", args.amount.toFixed(2), categoryName);
}

// After (same shape — inner try/catch):
for (const m of memberships) {
  try {
    await sendLargeChargePush(env, m.userId, args.merchant ?? "An unusual charge", args.amount.toFixed(2), categoryName);
  } catch (err) {
    logError({ transactionId: args.transactionId, recipientUserId: m.userId, err }, "large-charge push to recipient failed");
  }
}
```

### `apps/api/src/cron/jobs/goal-milestones.ts`

```ts
// Before (lines 39-45):
const memberships = await prisma.membership.findMany({ where: { workspaceId: g.workspaceId, role: { in: ["owner", "editor"] } }, select: { userId: true } });
for (const m of memberships) {
  await sendGoalMilestonePush(env, m.userId, g.title, crossed);
}

// After:
const memberships = await prisma.membership.findMany({ where: { workspaceId: g.workspaceId, role: { in: ["owner", "editor"] } }, select: { userId: true } });
for (const m of memberships) {
  try {
    await sendGoalMilestonePush(env, m.userId, g.title, crossed);
  } catch (err) {
    logError({ cron: CRON_NAME, goalId: g.id, recipientUserId: m.userId, err }, "goal-milestone push to recipient failed");
  }
}
```

The OUTER try/catch in each helper stays — it catches Prisma errors (findMany, update) so total fan-out doesn't crash the caller.

## 4. Tasks

### T1 — Production fix + test contract updates (1 commit)

Modify 3 production files + 2 test files in one atomic commit. Reasoning: the production change MUST land together with the contract updates to keep `main` green at every commit boundary.

Files:
- Modify: `apps/api/src/push/transaction-added.ts`
- Modify: `apps/api/src/push/anomaly.ts`
- Modify: `apps/api/src/cron/jobs/goal-milestones.ts`
- Modify: `apps/api/tests/push.transaction-added.test.ts` (test 5 contract change)
- Modify: `apps/api/tests/cron.goal-milestones.test.ts` (test 9 contract change)

Test 5 (transaction-added) update:
```ts
// Before:
expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(1);

// After:
expect(vi.mocked(sendMod.sendTransactionAddedPush)).toHaveBeenCalledTimes(2);
// Comment: per-recipient try/catch — first throws, second still attempted.
```

Test 9 (goal-milestones) update:
```ts
// Before:
const states = [a.lastMilestonePct, b.lastMilestonePct].sort((x, y) => (x ?? -1) - (y ?? -1));
expect(states).toEqual([null, 100]);

// After:
expect(a.lastMilestonePct).toBe(100);
expect(b.lastMilestonePct).toBe(100);
// Comment: per-recipient try/catch — even though one push threw, the goal.update STILL fires for both goals.
```

**Commit:** `fix(push): per-recipient try/catch in 3 fan-out helpers + update test contracts`

### T2 — Extract `tests/helpers/factories.ts` + migrate (1 commit)

Files:
- Create: `apps/api/tests/helpers/factories.ts`
- Modify: `apps/api/tests/push.transaction-added.test.ts` (use factory)
- Modify: `apps/api/tests/cron.goal-milestones.test.ts` (use factory)
- Modify: `apps/api/tests/cron.push-receipts.test.ts` (use factory)
- Modify: `apps/api/tests/push.send.test.ts` (use `makeUserWithDevices` factory)

`factories.ts` exports:
```ts
let counter = 0;

export async function createTestUser(prefix = "u"): Promise<string> { ... }
export async function setupWorkspaceWithRoles(
  roles: Array<"owner" | "editor" | "viewer">,
  prefix = "w",
): Promise<{ wsId: string; userIds: string[] }> { ... }
export async function createTestCategory(wsId: string, name?: string): Promise<string> { ... }
export async function makeUserWithDevices(
  tokens: Array<{ token: string; platform: "ios" | "android" }>,
  notificationPrefs?: Record<string, boolean>,
): Promise<{ userId: string; deviceIds: string[] }> { ... }
```

Migrated files drop their inline helpers (saves ~120 LOC across 4 files).

**NOT migrated** (older 1L-1M tests): `push.anomaly.test.ts`, `cron.trial-expiring.test.ts`, `goals.savings.test.ts`. They stay until next touch.

**Commit:** `refactor(api/tests): extract factories.ts helper + migrate 4 test files`

### T3 — Payload-shape coverage for 7 wrappers (1 commit)

Files:
- Modify: `apps/api/tests/push.send.test.ts` (append new describe + helper)

Add helper at top of file (or in `factories.ts` if generally useful — leaning toward push.send.test.ts since it's spy-specific):
```ts
function firstPushMessage(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  const calls = spy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const firstCall = calls[0]!;
  const chunk = firstCall[0] as Array<Record<string, unknown>>;
  expect(chunk.length).toBeGreaterThan(0);
  return chunk[0]!;
}
```

Then 7 nested describe blocks (one per wrapper), each with 1-2 payload-shape tests = 9 tests total.

**Commit:** `test(api): payload-shape coverage for 7 remaining sendXxxPush wrappers`

### T4 — Final regression check + documentation refresh (1 commit, docs-only)

Files:
- Modify: `docs/superpowers/plans/2026-05-25-plan-1u-failstop-fix-and-coverage.md` (mark all `[x]`)
- (Optional) Add 1-line comment in `transaction-added.ts:26` referencing "per-recipient containment per Plan 1U" — surfaces the design intent to future maintainers.

**Commit:** `docs(plan): plan 1U closeout — fail-stop fix + factories + 7 wrapper payloads shipped`

## 5. Risks

| Risk | Mitigation |
|---|---|
| T1 contract change in test 9 — could shift product semantics (a "milestone-notified" goal might have had 0 actual successful notifications). | Documented in §3. The state update was already "best-effort" given the outer try/catch swallows; making it ALSO advance on per-recipient failure is a deliberate UX choice (don't keep re-firing milestones every cron run). |
| T2 migration broke a file's mock setup (e.g., `makeUserWithDevices` factory might not match push.send.test.ts's needs perfectly) | Each migrated file's tests must pass before commit. |
| T3 `firstPushMessage` helper — if `vi.spyOn` types don't match across vitest versions, the cast might break | Use `MockInstance` type from `vitest` for the spy param. |
| Cross-test mock state leakage during T1 atomic commit | All tests in scope use `afterEach(clearAllMocks)`. Safe. |
| Pre-existing failure modes in non-touched files | Out of scope; T4 verifies full suite still green. |
| Helper `counter` global shared across test files via factories.ts | Module-scoped `let counter = 0` is per-process. Vitest singleFork ensures sequential file execution. ✓ |
| Migration touches 4 files in T2 — large diff | Each file's diff is small (helper removal + import). Net LOC negative. |
| T3 nested describes vs flat — Plan 1O used nested for channel-gate. Stay consistent? | Yes — match Plan 1O nested describe pattern for the 7 wrappers. |

## 6. Success criteria

- T1: 3 production files modified, 2 test contracts updated, all related tests pass.
- T2: factories.ts exported + 4 files migrated, all tests pass, net LOC reduction in test files.
- T3: 7 wrappers × 1-2 payload tests = 9 tests passing.
- T4: docs committed, full `@fina/api` suite regression: 0 new fails.
- Typecheck baseline unchanged.
- **4 commits total**, atomic boundaries (main always green).

## 7. Follow-ups (별도 plans)

- **Plan 1V**: Plaid-sync→anomaly integration (`daily-refresh.ts:108`), Plaid webhook→bank-reconnect (`webhook-item.ts:35`), scheduled-spend-match cron behavior.
- **Migrate remaining test files** to factories.ts (`push.anomaly.test.ts`, `cron.trial-expiring.test.ts`, `goals.savings.test.ts`) when next touched.
- **Brittleness fixes from R2** (deferred to a separate refactor PR): `goals.savings.test.ts` proration → `toBeCloseTo`; `http.push-integration.test.ts` tuple assertions.
- Decide product semantics: should per-recipient failure REVERT the state update? (Current Plan 1U: no, fire-and-forget the state update. Alternative: track per-recipient success and only update state if ≥1 succeeded.)
