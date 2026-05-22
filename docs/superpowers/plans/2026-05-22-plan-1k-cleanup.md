# Plan 1K-cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 13 baseline test failures on `main` from accumulated fixture drift (4 STRIPE env vars + 4 duplicate stale registry-count assertions).

**Architecture:** Two independent fixture edits. T1 extends `env.test.ts` `baseEnv()` with 4 STRIPE stubs. T2 consolidates 4 duplicate `it("registry has 22 tools total")` blocks down to 1 in `chat.tools.registry.test.ts` with corrected count (28) and label.

**Tech Stack:** Vitest, Zod (env.ts validation). Direct edits on main — no worktree (50-line diff total, no behavioral changes).

---

## Task 1: `env.test.ts` `baseEnv()` STRIPE stubs

**Files:**
- Modify: `apps/api/tests/env.test.ts:5-17`

- [ ] **Step 1.1: Run failing tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/env.test.ts 2>&1 | tail -5
```

Expected: 9 fails (RESEND_API_KEY refine cases, new keys cases, TRUST_PROXY strict opt-in cases). Each error message contains `STRIPE_SECRET_KEY: Required` because `baseEnv()` doesn't supply Stripe env vars and post-billing-stripe `env.ts` requires them.

- [ ] **Step 1.2: Edit `baseEnv()`**

In `apps/api/tests/env.test.ts`, replace the body of `baseEnv()` (lines 5-17) with:

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
    TRUST_PROXY: "false", // NEW: 1J Task 2 strict opt-in requires explicit value
    // NEW (1K): billing-stripe merged required Stripe env vars. Use clear
    // "_stub" suffixes so future readers see "this is a test fixture, not a
    // real secret".
    STRIPE_SECRET_KEY: "sk_test_stub",
    STRIPE_WEBHOOK_SECRET: "whsec_stub",
    STRIPE_PRICE_LITE_MONTHLY: "price_lite_stub",
    STRIPE_PRICE_PRO_MONTHLY: "price_pro_stub",
  };
}
```

- [ ] **Step 1.3: Re-run tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/env.test.ts 2>&1 | tail -5
```

Expected: all 11 tests pass.

- [ ] **Step 1.4: Commit**

```bash
git add apps/api/tests/env.test.ts
git commit -m "fix(test): env.test.ts baseEnv() — add STRIPE stubs

billing-stripe (merged 2026-05-21) added 4 required STRIPE env vars
to env.ts (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
STRIPE_PRICE_LITE_MONTHLY, STRIPE_PRICE_PRO_MONTHLY) but env.test.ts
baseEnv() fixture wasn't updated. 9 tests on main were failing with
'STRIPE_SECRET_KEY: Required' from zod validation.

Added 4 stubs with '_stub' suffix so future readers see they're test
fixtures, not real secrets. testEnv() helper (apps/api/tests/helpers/
test-env.ts) is unaffected — it builds Env directly, bypassing zod."
```

---

## Task 2: `chat.tools.registry.test.ts` consolidate count assertions

**Files:**
- Modify: `apps/api/tests/chat.tools.registry.test.ts`

- [ ] **Step 2.1: Read the file**

```bash
grep -n "registry has 22 tools total\|describe(\"REGISTRY" apps/api/tests/chat.tools.registry.test.ts
```

Expected: 4 `it("registry has 22 tools total", ...)` blocks across describes for plans 1c-budget, 1c-confirmation, 1c-merchant-map, 1c-recurring-persist. Each currently asserts `expect(REGISTRY).toHaveLength(27)`.

- [ ] **Step 2.2: Run failing tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.registry.test.ts 2>&1 | tail -5
```

Expected: 4 fails — each asserts 27, actual is 28 (pauseDailyBrief added by 2B).

- [ ] **Step 2.3: Remove 3 duplicate count assertions**

In `apps/api/tests/chat.tools.registry.test.ts`, find each of the FIRST THREE describe blocks:
1. `describe("REGISTRY (plan 1c-budget)", ...)`
2. `describe("REGISTRY (plan 1c-confirmation)", ...)`
3. `describe("REGISTRY (plan 1c-merchant-map)", ...)`

Inside each, delete the entire `it("registry has 22 tools total", () => { expect(REGISTRY).toHaveLength(27); });` block (and the blank line after it, if any). Keep all OTHER `it()` blocks in those describes (the plan-specific tool registration assertions stay).

- [ ] **Step 2.4: Update the surviving block**

In the FOURTH describe block — `describe("REGISTRY (plan 1c-recurring-persist)", ...)` — find the surviving `it("registry has 22 tools total", () => { expect(REGISTRY).toHaveLength(27); });` and replace it with:

```ts
it("registry has 28 tools total", () => {
  // Cumulative source-of-truth count. Bump this when a new tool is added
  // to apps/api/src/chat/tools/index.ts REGISTRY. The number is checked
  // ONCE here, not in every plan-specific describe (prior duplicates
  // removed in 1K-cleanup).
  expect(REGISTRY).toHaveLength(28);
});
```

- [ ] **Step 2.5: Re-run tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.registry.test.ts 2>&1 | tail -5
```

Expected: all tests pass. Test count drops by 3 (4 dup → 1 retained), so total count = previous_count - 3.

- [ ] **Step 2.6: Commit**

```bash
git add apps/api/tests/chat.tools.registry.test.ts
git commit -m "fix(test): chat.tools.registry — consolidate cumulative count

The file had 4 duplicate it('registry has 22 tools total') blocks
(one per describe for plans 1c-budget, 1c-confirmation, 1c-merchant-
map, 1c-recurring-persist). All asserted toHaveLength(27) — stale
since 2B's pauseDailyBrief tool addition brought count to 28. Labels
said '22' from an even-earlier era.

Removed 3 duplicates, kept the assertion in (plan 1c-recurring-
persist) — the latest plan that touched it. Updated label and number
to '28 tools total' / toHaveLength(28). Added a comment naming this
as the cumulative source-of-truth count for future bumps.

Plan-specific registration assertions ('addRecurring is registered',
etc.) in each describe are preserved."
```

---

## Final verification

- [ ] **Verify both files now pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/env.test.ts tests/chat.tools.registry.test.ts 2>&1 | tail -5
```

Expected: 0 fails across both files.

- [ ] **Confirm full-suite improvement**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -5
```

Expected: pass count up by 13 vs pre-1K baseline (was 1016 pass / 13 fail; now should be ~1026 pass / 0-2 fail). The 0-2 residual fails are plaid.routes.test.ts / chat.migration.smoke.test.ts deadlock flakes (out of scope per spec §1).

- [ ] **Typecheck**

```bash
pnpm --filter @fina/api exec tsc --noEmit -p apps/api/tsconfig.app.json 2>&1 | tail -5
```

Expected: only pre-existing baseline errors (Prisma `$Enums`, `exactOptionalPropertyTypes` on pino — unchanged by 1K).

---

## No new commits / no @fina/shared changes / no schema migrations

This is purely a test fixture cleanup. 2 commits total.
