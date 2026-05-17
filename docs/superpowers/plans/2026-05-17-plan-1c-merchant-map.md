# Plan 1C-merchant-map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `mapMerchantToCategory` chat tool — pre-binds or rebinds a merchant→category mapping and retroactively assigns null-category siblings (including rows whose `merchantNormalized` is still NULL).

**Architecture:** A shared service module `apps/api/src/categorize/map-merchant.ts` does category resolution → atomic upsert + backfill in a single `prisma.$transaction`, mirroring `manual-categorize.ts`'s null-sibling normalization step. The chat tool is a thin wrapper that resolves `category_name` to id and hydrates the canonical name into the response. Registry count bumps 17 → 18. System prompt's existing write-tool sentence extends to include `mapMerchantToCategory`.

**Tech Stack:** TypeScript ESM monorepo, Fastify, Prisma + Postgres on 5433, Vitest (singleFork).

**Spec:** [`docs/superpowers/specs/2026-05-17-plan-1c-merchant-map-design.md`](../specs/2026-05-17-plan-1c-merchant-map-design.md)

**Worktree:** This plan should be implemented in an isolated worktree branched from main. The subagent-driven-development skill will set this up via `EnterWorktree`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/categorize/map-merchant.ts` | `mapMerchantToCategoryService` — normalize, validate, atomic upsert + backfill |
| `apps/api/src/chat/tools/map-merchant-to-category.ts` | Chat tool: Zod args, category resolution, canonical-name hydration |
| `apps/api/src/chat/tools/index.ts` | Register the new tool with `as ToolDef` cast (17 → 18) |
| `apps/api/src/chat/turn.ts` | Extend write-tool confirmation sentence in SYSTEM_PROMPT |
| `apps/api/tests/chat.tools.registry.test.ts` | Bump 17 → 18; add `REGISTRY (plan 1c-merchant-map)` describe block |
| `apps/api/tests/categorize.map-merchant.test.ts` | 9 service cases |
| `apps/api/tests/chat.tools.map-merchant-to-category.test.ts` | 5 chat-tool cases |

No schema changes. No new dependencies. No HTTP route.

---

## Pre-flight Sanity Check

From the worktree root:

```bash
docker ps --filter name=fina-postgres-dev --format "{{.Names}}: {{.Status}}"
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy
pnpm --filter @fina/api exec prisma generate
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** `fina-postgres-dev: Up …`. Both `db:deploy` "No pending migrations". Test suite: `70 passed / 578 passed`.

If the suite is not at baseline, stop and report — do NOT start implementation on a broken baseline.

---

## Task 1: `mapMerchantToCategoryService` (TDD)

**Files:**
- Create: `apps/api/src/categorize/map-merchant.ts`
- Create: `apps/api/tests/categorize.map-merchant.test.ts`

### 1.1 Write the failing tests

- [ ] **Step 1: Create `apps/api/tests/categorize.map-merchant.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { mapMerchantToCategoryService } from "../src/categorize/map-merchant.js";

describe("mapMerchantToCategoryService", () => {
  let workspaceId: string;
  let categoryId: string;
  let otherCategoryId: string;
  let acctId: string;

  beforeEach(async () => {
    const stamp = `mm-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "MM", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "mm-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId: stamp, workspaceId, role: "owner" } });
    categoryId = (await prisma.category.create({ data: { workspaceId, name: "Coffee" } })).id;
    otherCategoryId = (await prisma.category.create({ data: { workspaceId, name: "Food" } })).id;
    acctId = (await prisma.bankAccount.create({ data: { workspaceId, name: "x", type: "depository" } })).id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  async function seedTx(opts: {
    merchantRaw: string;
    merchantNormalized: string | null;
    categoryId: string | null;
    categorizationSource?: "manual" | "mapping" | "ai" | null;
  }): Promise<string> {
    const tx = await prisma.transaction.create({
      data: {
        workspaceId,
        accountId: acctId,
        plaidTransactionId: `tx-${Math.random()}`,
        amount: "10.00",
        currency: "CAD",
        merchantRaw: opts.merchantRaw,
        merchantNormalized: opts.merchantNormalized,
        categoryId: opts.categoryId,
        categorizationSource: opts.categorizationSource ?? null,
        occurredAt: new Date("2026-05-10T12:00:00Z"),
        rawData: {},
      },
    });
    return tx.id;
  }

  it("creates a new mapping when none exists; backfilledCount=0 if no txs", async () => {
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    expect(r.mapping.merchantNormalized).toBe("starbucks");
    expect(r.mapping.categoryId).toBe(categoryId);
    expect(r.backfilledCount).toBe(0);
    const mapping = await prisma.merchantMapping.findUnique({
      where: { workspaceId_merchantNormalized: { workspaceId, merchantNormalized: "starbucks" } },
    });
    expect(mapping?.source).toBe("manual");
    expect(mapping?.confidence.toString()).toBe("1");
  });

  it("upserts an existing mapping (changes categoryId, keeps source=manual + confidence=1.00)", async () => {
    await prisma.merchantMapping.create({
      data: { workspaceId, merchantNormalized: "starbucks", categoryId: otherCategoryId, source: "ai", confidence: 0.6 },
    });
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    expect(r.mapping.categoryId).toBe(categoryId);
    const mapping = await prisma.merchantMapping.findUnique({
      where: { workspaceId_merchantNormalized: { workspaceId, merchantNormalized: "starbucks" } },
    });
    expect(mapping?.categoryId).toBe(categoryId);
    expect(mapping?.source).toBe("manual");
    expect(mapping?.confidence.toString()).toBe("1");
  });

  it("backfills null-category siblings with matching merchantNormalized", async () => {
    const txId = await seedTx({ merchantRaw: "Starbucks", merchantNormalized: "starbucks", categoryId: null });
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    expect(r.backfilledCount).toBe(1);
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    expect(tx?.categoryId).toBe(categoryId);
    expect(tx?.categorizationSource).toBe("mapping");
  });

  it("backfills siblings whose merchantNormalized IS NULL when merchantRaw normalizes to target", async () => {
    const txId = await seedTx({
      merchantRaw: "STARBUCKS #1234 TORONTO ON",
      merchantNormalized: null,
      categoryId: null,
    });
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "starbucks" },
    );
    expect(r.backfilledCount).toBe(1);
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    expect(tx?.merchantNormalized).toBe("starbucks");
    expect(tx?.categoryId).toBe(categoryId);
    expect(tx?.categorizationSource).toBe("mapping");
  });

  it("does NOT touch already-categorized siblings", async () => {
    const txId = await seedTx({
      merchantRaw: "Starbucks",
      merchantNormalized: "starbucks",
      categoryId: otherCategoryId,
      categorizationSource: "manual",
    });
    const r = await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    expect(r.backfilledCount).toBe(0);
    const tx = await prisma.transaction.findUnique({ where: { id: txId } });
    expect(tx?.categoryId).toBe(otherCategoryId);
    expect(tx?.categorizationSource).toBe("manual");
  });

  it("cross-workspace isolation — mapping in WS A does not backfill WS B", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other-mm-ws" } });
    const otherAcct = await prisma.bankAccount.create({
      data: { workspaceId: otherWs.id, name: "x", type: "depository" },
    });
    const otherTx = await prisma.transaction.create({
      data: {
        workspaceId: otherWs.id,
        accountId: otherAcct.id,
        plaidTransactionId: "other-tx",
        amount: "10.00",
        currency: "CAD",
        merchantRaw: "Starbucks",
        merchantNormalized: "starbucks",
        categoryId: null,
        occurredAt: new Date("2026-05-10T12:00:00Z"),
        rawData: {},
      },
    });
    await mapMerchantToCategoryService(
      { workspaceId },
      { categoryId, merchant: "Starbucks" },
    );
    const tx = await prisma.transaction.findUnique({ where: { id: otherTx.id } });
    expect(tx?.categoryId).toBeNull();
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("rejects whitespace-only input → invalid_merchant", async () => {
    await expect(
      mapMerchantToCategoryService({ workspaceId }, { categoryId, merchant: "   " }),
    ).rejects.toThrow("invalid_merchant");
  });

  it("rejects cross-workspace categoryId → category_not_found", async () => {
    const otherWs = await prisma.workspace.create({ data: { name: "other-cat-ws" } });
    const otherCat = await prisma.category.create({ data: { workspaceId: otherWs.id, name: "X" } });
    await expect(
      mapMerchantToCategoryService(
        { workspaceId },
        { categoryId: otherCat.id, merchant: "Starbucks" },
      ),
    ).rejects.toThrow("category_not_found");
    await prisma.workspace.delete({ where: { id: otherWs.id } });
  });

  it("rejects archived category → category_not_found", async () => {
    await prisma.category.update({ where: { id: categoryId }, data: { archivedAt: new Date() } });
    await expect(
      mapMerchantToCategoryService({ workspaceId }, { categoryId, merchant: "Starbucks" }),
    ).rejects.toThrow("category_not_found");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/categorize.map-merchant.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** error citing missing `../src/categorize/map-merchant.js`.

### 1.2 Implement the service

- [ ] **Step 3: Create `apps/api/src/categorize/map-merchant.ts`**

```typescript
import { prisma } from "../db.js";
import { normalizeMerchant } from "./normalize.js";

export type MapMerchantInput = { categoryId: string; merchant: string };
export type MapMerchantOutput = {
  mapping: { merchantNormalized: string; categoryId: string };
  backfilledCount: number;
};

export async function mapMerchantToCategoryService(
  ctx: { workspaceId: string },
  input: MapMerchantInput,
): Promise<MapMerchantOutput> {
  const merchantNormalized = normalizeMerchant(input.merchant);
  if (merchantNormalized.length === 0) {
    throw new Error("invalid_merchant");
  }

  const category = await prisma.category.findFirst({
    where: { id: input.categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
    select: { id: true },
  });
  if (!category) throw new Error("category_not_found");

  const backfilledCount = await prisma.$transaction(async (db) => {
    await db.merchantMapping.upsert({
      where: {
        workspaceId_merchantNormalized: {
          workspaceId: ctx.workspaceId,
          merchantNormalized,
        },
      },
      create: {
        workspaceId: ctx.workspaceId,
        merchantNormalized,
        categoryId: input.categoryId,
        source: "manual",
        confidence: 1.0,
      },
      update: {
        categoryId: input.categoryId,
        source: "manual",
        confidence: 1.0,
      },
    });

    // Step 1: normalize NULL-merchantNormalized siblings whose raw text
    // matches. Mirrors apps/api/src/categorize/manual-categorize.ts:81-97.
    const prefix =
      merchantNormalized.length >= 3 ? merchantNormalized.slice(0, 3) : merchantNormalized;
    const nullSiblings = await db.transaction.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        merchantNormalized: null,
        merchantRaw: { mode: "insensitive", contains: prefix },
      },
      select: { id: true, merchantRaw: true },
    });
    for (const ns of nullSiblings) {
      if (normalizeMerchant(ns.merchantRaw) === merchantNormalized) {
        await db.transaction.update({
          where: { id: ns.id },
          data: { merchantNormalized },
        });
      }
    }

    // Step 2: assign categoryId to all null-category, non-removed siblings
    // whose merchantNormalized now matches (covers both pre-normalized and
    // just-normalized rows from step 1).
    const { count } = await db.transaction.updateMany({
      where: {
        workspaceId: ctx.workspaceId,
        merchantNormalized,
        categoryId: null,
        removedAt: null,
      },
      data: {
        categoryId: input.categoryId,
        categorizationSource: "mapping",
      },
    });
    return count;
  });

  return {
    mapping: { merchantNormalized, categoryId: input.categoryId },
    backfilledCount,
  };
}
```

- [ ] **Step 4: Run — expect PASS (9/9)**

```bash
pnpm --filter @fina/api exec vitest run tests/categorize.map-merchant.test.ts --reporter=basic 2>&1 | tail -10
```

**Expected:** `Tests  9 passed (9)`.

### 1.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/categorize/map-merchant.ts apps/api/tests/categorize.map-merchant.test.ts
git commit -m "feat(plan 1c-merchant-map): mapMerchantToCategoryService"
```

---

## Task 2: `mapMerchantToCategory` chat tool (TDD)

**Files:**
- Create: `apps/api/src/chat/tools/map-merchant-to-category.ts`
- Create: `apps/api/tests/chat.tools.map-merchant-to-category.test.ts`

### 2.1 Write the failing tests

- [ ] **Step 1: Create `apps/api/tests/chat.tools.map-merchant-to-category.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { mapMerchantToCategory } from "../src/chat/tools/map-merchant-to-category.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("mapMerchantToCategory chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let coffeeCatId: string;

  beforeEach(async () => {
    const stamp = `mmt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "MMT", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "mmt-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    coffeeCatId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("Zod rejects when both category_id and category_name are present", () => {
    const r = mapMerchantToCategory.args.safeParse({
      merchant: "Starbucks",
      category_id: coffeeCatId,
      category_name: "Coffee",
    });
    expect(r.success).toBe(false);
  });

  it("Zod rejects when neither category_id nor category_name is present", () => {
    const r = mapMerchantToCategory.args.safeParse({ merchant: "Starbucks" });
    expect(r.success).toBe(false);
  });

  it("resolves category_name case-insensitively and returns canonical categoryName", async () => {
    const out = await mapMerchantToCategory.run(ctx, {
      merchant: "Starbucks",
      category_name: "coffee",
    });
    expect(out.mapping.categoryId).toBe(coffeeCatId);
    expect(out.mapping.categoryName).toBe("Coffee");
  });

  it("includes backfilledCount in result", async () => {
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "x", type: "depository" },
    });
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct.id,
        plaidTransactionId: "t1",
        amount: "10.00",
        currency: "CAD",
        merchantRaw: "Starbucks",
        merchantNormalized: "starbucks",
        categoryId: null,
        occurredAt: new Date("2026-05-10T12:00:00Z"),
        rawData: {},
      },
    });
    const out = await mapMerchantToCategory.run(ctx, {
      merchant: "Starbucks",
      category_id: coffeeCatId,
    });
    expect(out.backfilledCount).toBe(1);
  });

  it("mapping.merchantNormalized is server-normalized (raw with store id/location → 'starbucks')", async () => {
    const out = await mapMerchantToCategory.run(ctx, {
      merchant: "STARBUCKS #1234 TORONTO ON",
      category_id: coffeeCatId,
    });
    expect(out.mapping.merchantNormalized).toBe("starbucks");
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.map-merchant-to-category.test.ts --reporter=basic 2>&1 | tail -10
```

### 2.2 Implement the chat tool

- [ ] **Step 3: Create `apps/api/src/chat/tools/map-merchant-to-category.ts`**

```typescript
import { z } from "zod";
import { prisma } from "../../db.js";
import { mapMerchantToCategoryService } from "../../categorize/map-merchant.js";
import type { ToolDef } from "./types.js";

const Args = z
  .object({
    merchant: z
      .string()
      .min(1)
      .max(200)
      .describe("Raw merchant text — server normalizes to lowercase + strips store IDs / locations."),
    category_id: z.string().min(1).optional(),
    category_name: z.string().min(1).max(40).optional(),
  })
  .refine((a) => Boolean(a.category_id) !== Boolean(a.category_name), {
    message: "Provide exactly one of category_id or category_name",
  });

type Args = z.infer<typeof Args>;

export const mapMerchantToCategory: ToolDef<
  Args,
  {
    mapping: { merchantNormalized: string; categoryId: string; categoryName: string };
    backfilledCount: number;
  }
> = {
  name: "mapMerchantToCategory",
  description:
    "Bind a merchant to a category. Upserts the mapping and retroactively assigns null-category siblings whose merchantRaw normalizes to the same value. Use category_id when known, else category_name (case-insensitive).",
  args: Args,
  async run(ctx, args) {
    let categoryId = args.category_id;
    let categoryName: string;
    if (categoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: categoryId, workspaceId: ctx.workspaceId, archivedAt: null },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryName = cat.name;
    } else {
      const cat = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.category_name!, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });
      if (!cat) throw new Error("category_not_found");
      categoryId = cat.id;
      categoryName = cat.name;
    }
    const out = await mapMerchantToCategoryService(
      { workspaceId: ctx.workspaceId },
      { categoryId, merchant: args.merchant },
    );
    return {
      mapping: { ...out.mapping, categoryName },
      backfilledCount: out.backfilledCount,
    };
  },
};
```

- [ ] **Step 4: Run — expect PASS (5/5)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.map-merchant-to-category.test.ts --reporter=basic 2>&1 | tail -10
```

### 2.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/map-merchant-to-category.ts apps/api/tests/chat.tools.map-merchant-to-category.test.ts
git commit -m "feat(plan 1c-merchant-map): mapMerchantToCategory chat tool"
```

---

## Task 3: Register + system prompt + registry bump

**Files:**
- Modify: `apps/api/src/chat/tools/index.ts`
- Modify: `apps/api/src/chat/turn.ts`
- Modify: `apps/api/tests/chat.tools.registry.test.ts`

### 3.1 Register in tools/index.ts

- [ ] **Step 1: Edit `apps/api/src/chat/tools/index.ts`**

Add the import alongside the other tool imports:

```typescript
import { mapMerchantToCategory } from "./map-merchant-to-category.js";
```

Append to the `REGISTRY: ToolDef[]` array (after the existing 17 entries) with the `as ToolDef` cast pattern the existing entries use:

```typescript
  mapMerchantToCategory as ToolDef,
```

### 3.2 Update SYSTEM_PROMPT

- [ ] **Step 2: Edit `apps/api/src/chat/turn.ts`**

Find the existing write-tool sentence (currently mentions `createCategory, addTransactionNote, setBudget`). Replace with:

```
For write tools (createCategory, addTransactionNote, setBudget, mapMerchantToCategory), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘' or 'Starbucks를 Coffee 카테고리로 자동분류'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?' or '식비 예산 줄여야 할까?' or 'Starbucks 카테고리 어디로 할까?'
```

In the actual file the sentence is a TypeScript template-string literal. Preserve quoting/backtick/concatenation as-is — only swap the listed content. Read lines around the existing sentence first.

### 3.3 Bump registry test

- [ ] **Step 3: Edit `apps/api/tests/chat.tools.registry.test.ts`**

a) Change the line `expect(REGISTRY).toHaveLength(17);` (around line 170) to `expect(REGISTRY).toHaveLength(18);`.

b) Append a new describe block after the existing `REGISTRY (plan 1c-budget)` block:

```typescript
describe("REGISTRY (plan 1c-merchant-map)", () => {
  const EXPECTED = [
    [
      "mapMerchantToCategory",
      "Bind a merchant to a category. Upserts the mapping and retroactively assigns null-category siblings whose merchantRaw normalizes to the same value. Use category_id when known, else category_name (case-insensitive).",
    ],
  ] as const;

  it("contains the new tool name", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description string from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("registry has 18 tools total", () => {
    expect(REGISTRY).toHaveLength(18);
  });

  it("mapMerchantToCategory is registered", () => {
    const names = REGISTRY.map((t) => t.name);
    expect(names).toContain("mapMerchantToCategory");
  });
});
```

- [ ] **Step 4: Run registry test — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.registry.test.ts --reporter=basic 2>&1 | tail -10
```

### 3.4 Commit

- [ ] **Step 5: Commit**

```bash
git diff --staged --stat
git add apps/api/src/chat/tools/index.ts apps/api/src/chat/turn.ts apps/api/tests/chat.tools.registry.test.ts
git commit -m "feat(plan 1c-merchant-map): register mapMerchantToCategory + system prompt"
```

---

## Task 4: Full suite verification + final sanity

**Files:** none (verification only).

### 4.1 Run the full API suite via nx

- [ ] **Step 1: Reset nx + run**

```bash
pnpm exec nx reset 2>&1 | tail -2
pnpm nx run api:test --skipNxCache 2>&1 | tail -10
```

**Expected:** all files pass. Count = baseline 70 + 2 new = **72 files**. Tests = baseline 578 + 9 service + 5 chat-tool + 4 registry-block cases = **596 tests** (±2 acceptable if any existing assertion's structure shifted; none should).

### 4.2 Sanity grep

- [ ] **Step 2: Confirm wiring**

```bash
grep -rn "mapMerchantToCategory" apps/api/src/ | head -10
```

**Expected:**
- `chat/tools/map-merchant-to-category.ts` defines the export.
- `chat/tools/index.ts` imports + registers it.
- `chat/turn.ts` SYSTEM_PROMPT mentions it in the write-tool sentence.

```bash
grep -n "mapMerchantToCategoryService" apps/api/src/
```

**Expected:** defined in `categorize/map-merchant.ts`; consumed by `chat/tools/map-merchant-to-category.ts`.

### 4.3 No new dependency

- [ ] **Step 3: Confirm `package.json` unchanged**

```bash
git diff main -- apps/api/package.json package.json
```

**Expected:** no output (unchanged).

### 4.4 Typecheck

- [ ] **Step 4: Verify no new TS errors**

```bash
./node_modules/.bin/tsc --noEmit -p apps/api/tsconfig.app.json 2>&1 | grep "error TS" | head -5
```

**Expected:** the pre-existing `apps/api/src/chat/turn.ts:131` `InputJsonValue` error remains (unrelated, present on main). NO new errors involving `map-merchant.ts`, `map-merchant-to-category.ts`, or the registry test.

If a new error appears in the budget plan's `get-budget.ts` style — `exactOptionalPropertyTypes` rejecting an undefined optional — see the analogous fix in commit `b88de06` and apply the same "omit the key unless it has a value" pattern.

---

## Self-Review Checklist (after all tasks)

Before final code review:

1. **Spec coverage:** Every spec §4 module, §5 error code, §6 system prompt, §7 file, §8 test is implemented by a task.
2. **Service test 4** (null-merchantNormalized backfill) actually exercises the `normalizeMerchant` step — the seeded `merchantRaw` is `"STARBUCKS #1234 TORONTO ON"` and the post-condition asserts both `merchantNormalized` AND `categoryId` are set.
3. **No throw escapes uncaught** — `mapMerchantToCategoryService` only throws `invalid_merchant` and `category_not_found`. Both are documented.
4. **`as ToolDef` cast** is present on the new registry entry (`exactOptionalPropertyTypes` + ToolDef variance).
5. **System prompt** changed in exactly one place — the write-tool sentence.

---

## Known limitations (documented in spec §10)

- Chat-only surface — no HTTP route.
- Bulk mapping (multiple merchants in one call) is out of scope.
- Override of already-categorized transactions is out of scope.
- Delete/unmap and list-mappings tools are explicit follow-ups.
- Punctuation-only inputs (e.g. `"###"`) currently pass `normalizeMerchant` unchanged and create real mappings; this is documented and acceptable for v1.
- `action_intents` / `audit_events` / rich blocks belong to separate 1C-confirmation / 1C-audit plans.
- UI changes are out of scope.

These are listed so a reviewer doesn't ask "why didn't you also fix X?" — the answer is "Section §10 of the spec".
