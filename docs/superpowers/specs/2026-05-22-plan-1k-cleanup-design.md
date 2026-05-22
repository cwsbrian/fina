# Plan 1K-cleanup — Design

**Date:** 2026-05-22
**Status:** Draft
**Pairs with:** None directly. Fixture-only cleanup of 13 baseline test failures on main that accumulated from billing-stripe (env additions) and gradual plan additions (registry counts).

---

## 1. Goal

Fix the 13 baseline test failures on `main` that have accumulated as new env vars + chat tools were added without corresponding fixture updates. All failures are fixture-level — no production code changes, no schema migrations.

### In scope (2 tasks)

| Code | Item | Failure count |
|---|---|---|
| **T1** | `apps/api/tests/env.test.ts` `baseEnv()` fixture missing 4 STRIPE env vars | 9 |
| **T2** | `apps/api/tests/chat.tools.registry.test.ts` 4 duplicate `"registry has 22 tools total"` blocks asserting stale 27 | 4 |

### Out of scope

| Item | Why |
|---|---|
| `tests/plaid.routes.test.ts` deadlock flakes (variable count) | DB concurrency / singleFork timing issue, not a fixture bug. Test infra concern (e.g., per-test schema isolation, retry policy). Separate plan if it becomes a regular problem. |
| `tests/chat.migration.smoke.test.ts` deadlock | Same root cause as above. Emerged after 2B's migration churn; intermittent. |
| `testEnv()` helper (`apps/api/tests/helpers/test-env.ts`) | Doesn't load via zod — builds `Env` object directly. STRIPE missing is fine. Don't touch. |

---

## 2. Shared library touchpoints

Per CLAUDE.md rule.

### Uses (existing)
None.

### Adds (new)
None.

This is backend-test-only — no shared lib impact.

---

## 3. Architecture

Two independent fixture edits in two separate test files. No cross-task ordering. Implementation order is arbitrary; recommend T1 → T2 alphabetical for readability.

### T1: `env.test.ts` `baseEnv()` extension

Current `baseEnv()` (`apps/api/tests/env.test.ts:5-14`):

```ts
function baseEnv(): NodeJS.ProcessEnv {
  return {
    DATABASE_URL: "postgresql://localhost/x",
    BETTER_AUTH_SECRET: "x".repeat(48),
    BETTER_AUTH_URL: "http://localhost:0",
    WEB_APP_URL: "http://localhost:3000",
    PLAID_CLIENT_ID: "x",
    PLAID_SECRET: "x",
    ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    GEMINI_API_KEY: "x",
    TRUST_PROXY: "false",
  };
}
```

`env.ts` (post billing-stripe) requires 4 more z.string() fields:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_LITE_MONTHLY`
- `STRIPE_PRICE_PRO_MONTHLY`

Add the 4 stubs to `baseEnv()`. Use semantically clear stub values (e.g., `STRIPE_SECRET_KEY: "sk_test_stub"`, `STRIPE_WEBHOOK_SECRET: "whsec_stub"`, `STRIPE_PRICE_LITE_MONTHLY: "price_lite_stub"`, `STRIPE_PRICE_PRO_MONTHLY: "price_pro_stub"`) so future readers see "this is a test stub".

### T2: `chat.tools.registry.test.ts` consolidation

The file has FOUR `describe` blocks (`REGISTRY (plan 1c-budget)`, `(plan 1c-confirmation)`, `(plan 1c-merchant-map)`, `(plan 1c-recurring-persist)`), each containing:

```ts
it("registry has 22 tools total", () => {
  expect(REGISTRY).toHaveLength(27);
});
```

(label says 22, assertion expects 27 — both stale.)

**Fix:**
1. Remove the `it("registry has 22 tools total", ...)` block from THREE describes (any 3 of the 4 — recommend keeping the LAST one chronologically, `(plan 1c-recurring-persist)`, since it was added when the count was 27).
2. In the surviving block, update label and number: `it("registry has 28 tools total", () => { expect(REGISTRY).toHaveLength(28); });`

This produces:
- 1 cumulative count assertion (DRY, single source of truth).
- Each describe still has its plan-specific tool registration assertions (e.g., `"addRecurring, listRecurring, removeRecurring are all registered"`).

---

## 4. Testing strategy

Each task is a pure fixture edit. Verification:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/env.test.ts tests/chat.tools.registry.test.ts
```

Expected: 100% pass (~11 env tests + ~22 registry tests after dedup).

Full suite: `~1029-1030 pass / 1-2 fail` — the residual fails are plaid/migration deadlock flakes which are out of scope.

---

## 5. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| STRIPE stub values look "real" enough to confuse future readers | Low | Use clear `"_stub"` suffixes. |
| Removing 3 duplicate `it()` blocks accidentally removes plan-specific assertions | Low | Read the file carefully; the duplicated assertion is identical text + identical assertion. Other `it()` blocks in each describe stay. |
| Registry count grows again and breaks the 28-tool assertion | High eventually | The single source of truth (1 assertion) makes the fix mechanical: bump the number. This is the design intent. |

---

## 6. Success criteria

- `tests/env.test.ts`: 11/11 pass.
- `tests/chat.tools.registry.test.ts`: 22-ish pass (4 cumulative-count duplicates removed → -3 tests, +1 updated).
- `tsc --noEmit` clean (no shared lib changes, no API source changes).
- Full suite: 13 fewer failures, plaid/migration flakes still potentially present (out of scope).

---

## 7. Follow-ups (post-1K)

- **plaid.routes.test.ts + chat.migration.smoke.test.ts deadlocks** — investigate per-test schema isolation or vitest `.retry(3)`. Could be 1L-test-infra or absorbed into a v1.5 hardening pass.
- **`testEnv()` ↔ `baseEnv()` divergence** — two test-env helpers in `apps/api/tests/`. testEnv (1J) builds Env object; baseEnv (env.test.ts local) feeds process.env. Worth unifying if a third helper appears.
