# Plan 1K-cleanup-test-baseline Design

**Status:** Draft → User review pending
**Predecessor:** Plan 1K-cleanup (shipped) + Plan 1K-cleanup-chat-index (shipped `593b770`).

## 1. Goal & scope

Full API suite의 6 test failures를 fix해서 green baseline 복원. 모두 production 변경에 따라가지 못한 stale assumptions — production은 정확. + suggest-split Pro-gate에 regression 방어 테스트 1개 추가.

**진단된 6 failures:**
- **`transactions.create-manual.test.ts` × 5**: commit `d67da12 feat(api+mobile): seed default accounts on bootstrap`이 워크스페이스 생성 시 5개 default accounts (Cash/Debit/Checking/Savings/Credit) 자동 시딩하도록 변경. 테스트는 "manual account = 1" 가정 → 실제 5 → AssertionError.
- **`recurring.routes.test.ts` × 1**: "POST 402 upgrade_required when trial expired (Free tier)" — recurring을 Pro-only로 가정한 wishful test. Production은 모든 tier 허용 (의도된 behavior — Plan 1K-cleanup-test-baseline decision).

**추가 작업 (regression 방어):**
- `budget-plans.ts:175`의 suggest-split Pro-only gate에 테스트가 없음. 사용자가 본 plan brainstorm 중 확인 요청 → production correct, test coverage 0 → 1개 추가.

**Out of scope:**
- `plaid.routes.test.ts` `55P03 lock_not_available` 메시지 — production NOWAIT retry 로직의 의도된 동작. 테스트 통과 중. 변경 없음.
- recurring route에 tier gate 추가 — 사용자 결정으로 거절 (recurring is free for all tiers).
- 다른 1K-era flake — full suite 분석 결과 더 없음.

## 2. Shared library touchpoints

**없음.** 모두 테스트 변경. `@fina/shared` 영향 0. Migration 0.

## 3. Test changes

### 3.1 `apps/api/tests/transactions.create-manual.test.ts` (5 fixes)

**Tests #1, #2, #4, #5** — `name: "Cash"` 필터 추가는 **deceptive** (R1 발견). Production `createManualTransactionService`는 `MANUAL_WHERE = { plaidItemId: null, plaidAccountId: null, archivedAt: null }`에서 `orderBy: createdAt asc`로 첫 매치를 reuse. 시드된 5개는 단일 `createMany` 한 batch라 `createdAt` 동률 → tiebreaker undefined → race 테스트가 Cash 아닌 Debit 등을 선택 가능 → `name: "Cash"` 필터 시 0건 → assertion crash.

올바른 fix: **behavioral contract을 검증** — "service가 manual account 하나를 픽업 / 동일 wsId의 후속 호출은 같은 account를 reuse / 중복 row 안 만듦". 시드 이름이 아니라 reuse semantics.

**Test #1** ("auto-creates a Cash manual account on first call"):
```ts
// Before:
const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
expect(accounts).toHaveLength(1);
expect(accounts[0]!.name).toBe("Cash");
expect(accounts[0]!.type).toBe("depository");
expect(accounts[0]!.currency).toBe("CAD");

// After:
const manualAccounts = await prisma.bankAccount.findMany({
  where: { workspaceId: wsId, plaidItemId: null, plaidAccountId: null, archivedAt: null },
});
// Bootstrap seeds 5 default manual accounts (Cash/Debit/Checking/Savings/
// Credit); service reused one of them for this transaction.
expect(manualAccounts.length).toBeGreaterThanOrEqual(1);
const picked = manualAccounts.find((a) => a.id === result.transaction.accountId);
expect(picked).toBeDefined();
expect(picked!.type).toBe("depository");
expect(picked!.currency).toBe("CAD");
// Cash is among the seed defaults, confirming the bootstrap path:
expect(manualAccounts.some((a) => a.name === "Cash")).toBe(true);
```

**Test #2** ("reuses the existing manual account on second call"): 두 transaction이 동일 accountId 갖는지 확인 — 이게 reuse의 진짜 시그니처. 시드 이름 무관:
```ts
// Before:
const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
expect(accounts).toHaveLength(1);
const txs = await prisma.transaction.findMany({ where: { workspaceId: wsId } });
expect(txs).toHaveLength(2);
expect(new Set(txs.map((t) => t.accountId))).toEqual(new Set([accounts[0]!.id]));

// After:
const manualBefore = await prisma.bankAccount.count({
  where: { workspaceId: wsId, plaidItemId: null, plaidAccountId: null, archivedAt: null },
});
// (2nd createManualTransactionService call happens between these — see test flow)
const txs = await prisma.transaction.findMany({ where: { workspaceId: wsId } });
expect(txs).toHaveLength(2);
// Both transactions reused the same manual account (reuse semantics);
// account identity doesn't matter — just that they collapsed onto one.
const accountIds = new Set(txs.map((t) => t.accountId));
expect(accountIds.size).toBe(1);
// Belt+suspenders: confirm the 2nd call didn't silently create a 6th
// manual row alongside the reuse.
const manualAfter = await prisma.bankAccount.count({
  where: { workspaceId: wsId, plaidItemId: null, plaidAccountId: null, archivedAt: null },
});
expect(manualAfter).toBe(manualBefore);
```

**Note**: in actual test code, `manualBefore` should be captured AFTER setup but BEFORE the first service call. Reorganize accordingly during implementation.

**Test #4** ("does NOT reuse a ghost ex-Plaid account"): 핵심은 ghost account가 픽업 안 되는 것. Reuse target이 어느 시드인지는 무관:
```ts
// Before:
const cashAccts = await prisma.bankAccount.findMany({
  where: { workspaceId: wsId, plaidAccountId: null, archivedAt: null },
});
expect(cashAccts).toHaveLength(1);
expect(cashAccts[0]!.name).toBe("Cash");
expect(result.transaction.accountId).toBe(cashAccts[0]!.id);

// After:
// The ghost (plaidAccountId set + archived) must NOT be picked. Bootstrap-
// seeded accounts (plaidAccountId=null + active) are the only legal targets.
const ghostId = (await prisma.bankAccount.findFirstOrThrow({
  where: { workspaceId: wsId, plaidAccountId: { not: null } },
})).id;
expect(result.transaction.accountId).not.toBe(ghostId);
const pickedAccount = await prisma.bankAccount.findUniqueOrThrow({
  where: { id: result.transaction.accountId },
});
expect(pickedAccount.plaidAccountId).toBeNull();
expect(pickedAccount.archivedAt).toBeNull();
```

**Test #5** ("race two concurrent first-time calls"): 두 동시 호출이 동일 account에 collapse:
```ts
// Before:
const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId, plaidItemId: null } });
expect(accounts).toHaveLength(1);
expect(r1.transaction.accountId).toBe(accounts[0]!.id);
expect(r2.transaction.accountId).toBe(accounts[0]!.id);

// After:
// Race semantics: both concurrent calls picked the SAME manual account
// (no duplicate creation, no split between two seed accounts).
expect(r1.transaction.accountId).toBe(r2.transaction.accountId);
// And it's an active, non-Plaid account from the bootstrap seed pool.
const picked = await prisma.bankAccount.findUniqueOrThrow({
  where: { id: r1.transaction.accountId },
});
expect(picked.plaidItemId).toBeNull();
expect(picked.plaidAccountId).toBeNull();
expect(picked.archivedAt).toBeNull();
```

**Test #3** (Transaction.currency inherits Workspace.currency) — 재구조화:
```ts
const { wsId, userId } = await setupEditor("mtcur@t.co");
// 시드된 Cash 5개는 CAD로 생성됨 → workspace를 USD로 갱신해도 이미 Cash가 있어서
// service가 재사용. 인헤리트 path를 검증하려면 시드 제거하고 currency 변경 후 fresh
// creation을 트리거해야 함.
await prisma.bankAccount.deleteMany({ where: { workspaceId: wsId } });
await prisma.workspace.update({ where: { id: wsId }, data: { currency: "USD" } });
const result = await createManualTransactionService(
  { workspaceId: wsId, userId },
  { merchantRaw: "X", amount: 1, occurredAt: "2026-05-17" },
);
expect(result.transaction.currency).toBe("USD");
const acct = await prisma.bankAccount.findFirstOrThrow({
  where: { workspaceId: wsId, name: "Cash", plaidItemId: null },
});
expect(acct.currency).toBe("USD");
```

`deleteMany`로 시드 5개 제거 → workspace를 USD로 → service가 새 Cash를 USD로 생성 → original intent 검증.

### 3.2 `apps/api/tests/recurring.routes.test.ts` (1 deletion)

`it("POST 402 upgrade_required when trial expired (Free tier)", ...)` block 통째로 삭제. 해당 테스트는 inline로 trial expiry 처리하므로 cleanup할 shared helper 없음 (다른 테스트와 fixture 공유 안 함). 위에 1줄 comment 추가:

```ts
// Recurring is free for all tiers (Plan 1K-cleanup-test-baseline 2026-05-25
// decision). No tier gate on POST /recurring. Previous '402 trial expired'
// test was a wishful assertion against production that never had the gate.
```

### 3.3 `apps/api/tests/budget-plans.routes.test.ts` (NEW — 1 test)

기존 파일 없음. 신규 생성:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

describe("POST /workspaces/:id/budget-plans/suggest-split", () => {
  it("402 upgrade_required for Free tier (trial expired + consumed)", async () => {
    const u = await signUpAndGetCookie(app, { email: `bp-free-${Date.now()}@t.co` });
    const wsId = await getOwnerWorkspaceId(u.userId);
    // Expire trial → Free tier.
    await prisma.user.update({
      where: { id: u.userId },
      data: {
        trialEndsAt: new Date(Date.now() - 86_400_000),
        trialConsumed: true,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/budget-plans/suggest-split`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { totalAmount: 1000 },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json()).toEqual({ error: "upgrade_required" });  // strict shape — no extra payload
  });
});
```

**왜 1개만**: production correct + main path는 이미 staging/manual로 검증됨. 본 plan의 의도는 Pro-gate regression 방어이지 전체 suggest-split coverage 확장 아님. 더 많은 coverage는 별도 plan.

## 4. Verification

1. **Targeted re-runs**:
   ```bash
   DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/transactions.create-manual.test.ts tests/recurring.routes.test.ts tests/budget-plans.routes.test.ts 2>&1 | tail -8
   ```
   Expected: all pass (existing pre-fix passes intact + 5 newly-fixed + 1 new + 1 fewer recurring test).

2. **Full suite regression**:
   ```bash
   DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -8
   ```
   Expected: 0 failures.

3. **Typecheck same**:
   ```bash
   pnpm --filter @fina/api exec tsc --noEmit -p apps/api/tsconfig.app.json 2>&1 | grep "error TS" | wc -l
   ```
   Expected: same as pre-fix baseline (10 or fewer, all pre-existing).

## 5. Testing

기존 테스트 자체가 verification + 1개 신규 (suggest-split Pro-gate). 추가 새 테스트 작성 불필요.

## 6. Risks

| Risk | Mitigation |
|---|---|
| #3 `deleteMany` 시 cascade 부작용 | bankAccount는 transaction의 FK target. Test에서 transaction이 만들어지기 전 deleteMany → no cascade. 안전. |
| `recurring` 테스트 삭제로 coverage 줄어듦 | 그 테스트는 wishful이라 어차피 production 검증 안 함. 손실 0. |
| budget-plans.routes.test.ts가 new file → 기존 setup pattern 안 맞을 수도 | spec §3.3 코드는 devices.routes.test.ts + recurring.routes.test.ts와 동일 pattern (shared app + beforeEach truncateAll). |
| 다른 stale tests 더 발견 | Full suite 한 번 돌려서 잔여 fail 0 확인 (verification §4 step 2). |

## 7. Success criteria

- Full API suite: 0 failures.
- 3 files changed: transactions.create-manual.test.ts (modified) + recurring.routes.test.ts (1 test deleted) + budget-plans.routes.test.ts (new).
- **3 commits, one per task** (Plan 1K-cleanup-chat-index의 single-commit과 달리 본 plan은 3개 독립 test 변경이라 per-task 분리 — cleaner revert paths).
- No schema / migration / shared / production changes.

## 8. Follow-ups

- budget-plans.routes 전체 coverage 확장 (현재는 Pro-gate 1개만). 별도 plan.
- 시드된 default accounts 관련 다른 stale tests (없음 확인 완료).
- plaid.routes의 `55P03` 메시지가 stdout 노이즈 — 별도 cosmetic plan (선택).
