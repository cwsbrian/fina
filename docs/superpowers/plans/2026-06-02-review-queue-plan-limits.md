# Review Queue Category And Plan Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Review Queue category changes apply immediately to pending transactions and same-merchant queue items, and change Pro's real Plaid item cap from 5 to 10.

**Architecture:** Keep simple category assignment separate from full split editing: pending Plaid rows may receive a single category allocation immediately, while multi-allocation split replacement remains blocked. Reuse the existing transaction PATCH path for the selected row, then return sibling transaction ids so the mobile Review Queue can remove all affected same-merchant rows from local state.

**Tech Stack:** Fastify API, Prisma, Nx/pnpm, Expo React Native.

---

### Task 1: Real Pro Plaid Item Limit

**Files:**
- Modify: `libs/shared/src/tier.ts`
- Modify tests: `apps/api/tests/plaid.tier.test.ts`, `apps/api/tests/plaid.routes.test.ts`
- Modify UI copy: `apps/mobile/app/plan/index.tsx`

- [ ] Write failing tests expecting Pro/trial `plaidItemLimit` to be `10`.
- [ ] Change `TIER_LIMITS.pro.plaidItems` to `10`.
- [ ] Update plan picker copy so Pro says “Up to 10 connected Plaid items”.
- [ ] Run targeted tier and route tests.

### Task 2: Pending Category Assignment

**Files:**
- Modify: `apps/api/src/transactions/edit.ts`
- Modify tests: `apps/api/tests/transactions.edit.service.test.ts`, `apps/api/tests/transactions.edit.route.test.ts`

- [ ] Write failing tests that PATCHing `{ categoryId }` on a pending Plaid transaction succeeds.
- [ ] Keep full `allocations` replacement blocked on pending Plaid rows.
- [ ] Run targeted transaction edit tests.

### Task 3: Same-Merchant Review Queue Apply

**Files:**
- Modify: `apps/api/src/transactions/edit.ts`
- Modify: `apps/api/src/routes/transactions.ts`
- Modify: `apps/mobile/src/categories/CategoryPickerSheet.tsx`
- Modify: `apps/mobile/app/categorize/inbox.tsx`

- [ ] Add response metadata for same-merchant review queue transactions updated by category assignment.
- [ ] Persist a merchant mapping immediately after manual category choice.
- [ ] Update mobile Review Queue so `onChange` removes selected and returned sibling ids.
- [ ] Run API tests and TypeScript checks.
