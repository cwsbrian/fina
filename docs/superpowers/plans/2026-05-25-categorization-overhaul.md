# Categorization Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 3-step categorize pipeline (explicit mapping → workspace history → LLM with Plaid PFC hint), per-allocation `needsConfirmation` driven by `User.categorizationMode` (flexible/strict/auto), Activity pill + bottom sheet + daily brief confirm card, auto-promote merchant_mapping after 3 confirms, snooze on sheet dismiss.

**Architecture:** Pipeline lives in `apps/api/src/categorize/service.ts` with new `auto-promote.ts` + helper modules. Schema gains 2 columns (`needsConfirmation`, `dismissedUntil`) on `TransactionAllocation`, 1 column (`categorizationMode`) on `User`, 1 enum value (`history`) on `CategorizationSource`, 1 new enum (`CategorizationMode`), and a partial index on transactions. Mobile gets a new `/categorization` settings screen, an Activity-pill + bottom-sheet flow, and a new `categorize_confirm_card` presentation block renderer.

**Tech Stack:** Fastify + Prisma 5 (Postgres) on the API, Expo SDK 54 React Native on mobile, `@gorhom/bottom-sheet` for the confirm sheet, `@fina/shared` for cross-app types + zod schemas, Gemini Flash Lite for LLM categorization (existing).

**Spec:** `docs/superpowers/specs/2026-05-25-categorization-overhaul-design.md`

---

## File structure

**Create:**
- `apps/api/src/categorize/needs-confirmation.ts` — pure function: `(mode, source, categoryName, archived) → boolean`
- `apps/api/src/categorize/other-detection.ts` — pure helper: is category name 'Other' case-insensitive, with archived check
- `apps/api/src/categorize/auto-promote.ts` — count + INSERT logic post-confirm
- `apps/api/src/categorize/history-lookup.ts` — batch query for prior categorized tx per merchantNormalized
- `apps/api/src/telemetry/categorize.ts` — `categorize.completed/confirmed`, `mapping.auto_promoted` event emitters (thin wrappers over `logInfo`)
- `apps/mobile/app/categorization/index.tsx` — Mode setting screen (3 radio cards)
- `apps/mobile/src/categorize/ConfirmSheet.tsx` — bottom sheet component (Confirm / Edit / dismiss-as-snooze)
- `apps/mobile/src/categorize/NeedsReviewPill.tsx` — pill rendering (yellow normal, red Other)

**Modify:**
- `libs/shared/src/dto/transactions.ts` — extend `AllocationDTO.source` + add `needsConfirmation`, `dismissedUntil`
- `libs/shared/src/dto/me.ts` — add `categorizationMode` to `MeDTO.user`
- `libs/shared/src/dto/chat.ts` — add `categorize_confirm_card` variant
- `libs/shared/src/schemas/me.ts` — add optional `categorizationMode` to `PatchMeBody`
- `libs/shared/src/index.ts` — export new `CategorizationMode` type/schema
- New file `libs/shared/src/categorization.ts` — `CategorizationMode` type + zod
- `apps/api/src/chat/blocks.ts` — mirror the new variant on API side
- `apps/api/prisma/schema.prisma` — User.categorizationMode, TransactionAllocation.needsConfirmation/dismissedUntil, CategorizationSource.history, CategorizationMode enum, partial index declaration
- `apps/api/prisma/migrations/<ts>_categorization_overhaul/migration.sql` — raw ALTER + partial index
- `apps/api/src/categorize/service.ts` — wire history step + needsConfirmation writes + race guard extension
- `apps/api/src/categorize/llm.ts` — accept PFC hint per tx, include in prompt
- `apps/api/src/routes/me.ts` — accept `categorizationMode` in PATCH
- `apps/api/src/routes/transactions.ts` — add POST `/confirm-category` + POST `/snooze-category`, modify PATCH to set `needsConfirmation=false` + `source='manual'` + trigger auto-promote
- `apps/api/src/cron/jobs/daily-brief.ts` — compute `lastBriefAt` window + emit `categorize_confirm_card` block
- `apps/mobile/app/(tabs)/more.tsx` — re-add "Categorization style" row
- `apps/mobile/app/(tabs)/activity.tsx` — render `NeedsReviewPill` on rows where applicable
- `apps/mobile/src/chat/PresentationBlock.tsx` — handle the new variant

**Test:**
- `apps/api/src/categorize/needs-confirmation.test.ts` — full matrix
- `apps/api/src/categorize/other-detection.test.ts` — Other / not Other / archived
- `apps/api/src/categorize/history-lookup.test.ts` — batch query, tiebreaker, archived-fall-through
- `apps/api/src/categorize/service.test.ts` — end-to-end pipeline cases
- `apps/api/src/categorize/auto-promote.test.ts` — count rule, race, edge cases
- `apps/api/src/cron/jobs/daily-brief.test.ts` — confirm card generation, window cap, snooze exclusion
- `apps/api/src/routes/transactions.confirm.test.ts` — new endpoints + PATCH semantics

---

## Task 1: Shared lib types

**Files:**
- Create: `libs/shared/src/categorization.ts`
- Modify: `libs/shared/src/dto/transactions.ts`
- Modify: `libs/shared/src/dto/me.ts`
- Modify: `libs/shared/src/dto/chat.ts`
- Modify: `libs/shared/src/schemas/me.ts`
- Modify: `libs/shared/src/index.ts`

- [ ] **Step 1: Create `categorization.ts` with mode type + schema**

```ts
// libs/shared/src/categorization.ts
import { z } from "zod";

export const CATEGORIZATION_MODES = ["flexible", "strict", "auto"] as const;
export type CategorizationMode = (typeof CATEGORIZATION_MODES)[number];

export const CategorizationModeSchema = z.enum(CATEGORIZATION_MODES);
```

- [ ] **Step 2: Extend `AllocationDTO`**

In `libs/shared/src/dto/transactions.ts`, replace the `source` line and add two new fields:

```ts
export type AllocationDTO = {
  id: string;
  categoryId: string | null;
  amount: string;
  source: "manual" | "ai" | "mapping" | "history" | null;
  needsConfirmation: boolean;
  /** ISO 8601 timestamp or null. When in the future, this allocation is snoozed. */
  dismissedUntil: string | null;
};
```

- [ ] **Step 3: Add `categorizationMode` to `MeDTO.user`**

In `libs/shared/src/dto/me.ts`, add the field right after `notificationPrefs`:

```ts
import type { CategorizationMode } from "../categorization.js";
// ...
    notificationPrefs: NotificationPrefs;
    categorizationMode: CategorizationMode;
  };
```

- [ ] **Step 4: Add `categorize_confirm_card` variant to `PresentationBlock`**

In `libs/shared/src/dto/chat.ts`, extend the union:

```ts
export type PresentationBlock =
  | { type: "text"; markdown: string }
  | {
      type: "confirm_card";
      question: string;
      accept_label: string;
      reject_label: string;
      accept_intent: string;
      reject_intent?: string;
    }
  | {
      type: "categorize_confirm_card";
      count: number;
      items: { txId: string; merchant: string; categoryName: string }[];
      moreCount: number;
    };
```

- [ ] **Step 5: Extend `PatchMeBody` schema**

In `libs/shared/src/schemas/me.ts`, import + add field:

```ts
import { CategorizationModeSchema } from "../categorization.js";
// ...
  notificationPrefs: NotificationPrefsSchema.optional(),
  categorizationMode: CategorizationModeSchema.optional(),
}).strict();
```

- [ ] **Step 6: Re-export from `libs/shared/src/index.ts`**

Add:

```ts
export * from "./categorization.js";
```

- [ ] **Step 7: Verify typecheck passes**

Run: `pnpm -F @fina/shared build` (or root `pnpm typecheck` for shared)
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add libs/shared/src/categorization.ts libs/shared/src/dto/transactions.ts libs/shared/src/dto/me.ts libs/shared/src/dto/chat.ts libs/shared/src/schemas/me.ts libs/shared/src/index.ts
git commit -m "feat(shared): types for categorization mode + needsConfirmation"
```

---

## Task 2: Prisma schema + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_categorization_overhaul/migration.sql`

- [ ] **Step 1: Add fields/enums to schema.prisma**

Edit `apps/api/prisma/schema.prisma`:

```prisma
// In User model, alongside other prefs:
  categorizationMode  CategorizationMode @default(flexible)

// In TransactionAllocation model:
  needsConfirmation Boolean   @default(false)
  dismissedUntil    DateTime?

// Add new enum near the other Categorization* enums:
enum CategorizationMode {
  flexible
  strict
  auto
}

// Extend CategorizationSource:
enum CategorizationSource {
  mapping
  ai
  manual
  history
}

// In Transaction model, add the partial index marker comment (real DDL goes in raw SQL):
//   @@index([workspaceId, merchantNormalized, occurredAt(sort: Desc)])
// (Prisma can't express WHERE clause natively; we keep the non-partial index in schema and override with raw SQL in migration. Both forms coexist; Postgres tolerates dup indexes but we drop the non-partial in the same migration.)
```

The cleanest path is to declare a non-partial index in the schema, then in the migration `DROP` it and `CREATE` the partial version. To keep schema + DB aligned, we instead declare nothing in schema and rely on raw SQL with `@@ignore` semantics — Prisma will still introspect the column for reads. Use the explicit non-partial index in schema and replace with partial in the same migration's raw SQL.

- [ ] **Step 2: Generate empty migration**

```bash
pnpm --filter @fina/api exec prisma migrate dev --create-only --name categorization_overhaul
```

Expected: a migration directory like `prisma/migrations/<TIMESTAMP>_categorization_overhaul/migration.sql` is created.

- [ ] **Step 3: Edit the generated `migration.sql` to ensure ALTER TYPE + partial index + columns are all there**

Inspect the auto-generated SQL. Prisma usually produces:

```sql
ALTER TYPE "CategorizationSource" ADD VALUE 'history';
CREATE TYPE "CategorizationMode" AS ENUM ('flexible', 'strict', 'auto');
ALTER TABLE "users" ADD COLUMN "categorizationMode" "CategorizationMode" NOT NULL DEFAULT 'flexible';
ALTER TABLE "transaction_allocations" ADD COLUMN "needsConfirmation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "transaction_allocations" ADD COLUMN "dismissedUntil" TIMESTAMP(3);
CREATE INDEX "transactions_workspaceId_merchantNormalized_occurredAt_idx" ON "transactions"("workspaceId", "merchantNormalized", "occurredAt" DESC);
```

Replace the last `CREATE INDEX` line with a partial-index version:

```sql
CREATE INDEX "transactions_workspaceId_merchantNormalized_occurredAt_idx"
  ON "transactions" ("workspaceId", "merchantNormalized", "occurredAt" DESC)
  WHERE "removedAt" IS NULL;
```

Save the file.

- [ ] **Step 4: Apply migration**

```bash
pnpm --filter @fina/api exec prisma migrate dev
```

Expected: migration applied to local dev DB, Prisma client regenerated.

- [ ] **Step 5: Verify Prisma client compiles**

Run: `pnpm -F @fina/api exec tsc --noEmit -p .` (or repo's typecheck path)
Expected: PASS (apart from preexisting LogContext / FinaEnv issues from earlier work)

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(db): migrate for categorization overhaul (mode, needsConfirmation, dismissedUntil, history source, partial index)"
```

---

## Task 3: Pure helper — `needs-confirmation.ts`

**Files:**
- Create: `apps/api/src/categorize/needs-confirmation.ts`
- Test: `apps/api/src/categorize/needs-confirmation.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/src/categorize/needs-confirmation.test.ts
import { describe, it, expect } from "vitest";
import { computeNeedsConfirmation } from "./needs-confirmation.js";

describe("computeNeedsConfirmation", () => {
  it("mapping source is always confirmed", () => {
    expect(computeNeedsConfirmation({ mode: "strict", source: "mapping", isOther: false, priorNeedsConfirmation: null })).toBe(false);
  });
  it("strict + history with prior unconfirmed → true", () => {
    expect(computeNeedsConfirmation({ mode: "strict", source: "history", isOther: false, priorNeedsConfirmation: true })).toBe(true);
  });
  it("flexible + ai new merchant → true", () => {
    expect(computeNeedsConfirmation({ mode: "flexible", source: "ai", isOther: false, priorNeedsConfirmation: null })).toBe(true);
  });
  it("auto + ai → false", () => {
    expect(computeNeedsConfirmation({ mode: "auto", source: "ai", isOther: false, priorNeedsConfirmation: null })).toBe(false);
  });
  it("Other category overrides mode (auto)", () => {
    expect(computeNeedsConfirmation({ mode: "auto", source: "ai", isOther: true, priorNeedsConfirmation: null })).toBe(true);
  });
  it("history with prior confirmed → false (all modes)", () => {
    expect(computeNeedsConfirmation({ mode: "strict", source: "history", isOther: false, priorNeedsConfirmation: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (fail)**

Run: `pnpm -F @fina/api exec vitest run src/categorize/needs-confirmation.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

```ts
// apps/api/src/categorize/needs-confirmation.ts
import type { CategorizationMode, CategorizationSource } from "@fina/shared";

export type NeedsConfirmationInput = {
  mode: CategorizationMode;
  source: Exclude<CategorizationSource, null>;
  isOther: boolean;
  /** For source='history' only: the prior allocation's needsConfirmation.
   *  Null/undefined for non-history sources. */
  priorNeedsConfirmation: boolean | null;
};

export function computeNeedsConfirmation(input: NeedsConfirmationInput): boolean {
  if (input.isOther) return true; // mode-override
  if (input.source === "mapping" || input.source === "manual") return false;
  if (input.source === "history") {
    if (input.priorNeedsConfirmation === false) return false;
    // prior unconfirmed (true) or unknown: mode rules
  }
  // source is 'ai' OR ('history' with unconfirmed prior)
  switch (input.mode) {
    case "strict":   return true;
    case "flexible": return input.source === "ai"; // history+unconfirmed in flexible is false
    case "auto":     return false;
  }
}
```

- [ ] **Step 4: Re-run test (pass)**

Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/categorize/needs-confirmation.ts apps/api/src/categorize/needs-confirmation.test.ts
git commit -m "feat(categorize): needsConfirmation rule (pure function)"
```

---

## Task 4: Pure helper — `other-detection.ts`

**Files:**
- Create: `apps/api/src/categorize/other-detection.ts`
- Test: `apps/api/src/categorize/other-detection.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/src/categorize/other-detection.test.ts
import { describe, it, expect } from "vitest";
import { isOtherCategory } from "./other-detection.js";

describe("isOtherCategory", () => {
  it("exact 'Other' name + not archived → true", () => {
    expect(isOtherCategory({ name: "Other", archivedAt: null })).toBe(true);
  });
  it("case-insensitive 'other' → true", () => {
    expect(isOtherCategory({ name: "other", archivedAt: null })).toBe(true);
  });
  it("with surrounding whitespace → true", () => {
    expect(isOtherCategory({ name: "  Other  ", archivedAt: null })).toBe(true);
  });
  it("archived 'Other' → false (rule disabled)", () => {
    expect(isOtherCategory({ name: "Other", archivedAt: new Date() })).toBe(false);
  });
  it("'Misc' → false", () => {
    expect(isOtherCategory({ name: "Misc", archivedAt: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test (fail)**

Run: `pnpm -F @fina/api exec vitest run src/categorize/other-detection.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/categorize/other-detection.ts
export function isOtherCategory(category: { name: string; archivedAt: Date | null }): boolean {
  if (category.archivedAt !== null) return false;
  return category.name.trim().toLowerCase() === "other";
}
```

- [ ] **Step 4: Re-run test (pass)**

Expected: PASS (5/5).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/categorize/other-detection.ts apps/api/src/categorize/other-detection.test.ts
git commit -m "feat(categorize): Other category detection (case-insensitive + archive aware)"
```

---

## Task 5: History lookup module

**Files:**
- Create: `apps/api/src/categorize/history-lookup.ts`
- Test: `apps/api/src/categorize/history-lookup.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/src/categorize/history-lookup.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { findHistoryHints } from "./history-lookup.js";
import { prisma } from "../db.js";
// Use existing test fixtures: createWorkspace, createCategory, createTransaction helpers.
// Assume `tests/factories.ts` exists. If not, this task expands to add tx factory.

describe("findHistoryHints", () => {
  it("returns the most recent allocation per merchantNormalized", async () => {
    // setup: workspace A with cat Dining, tx1 (STARBUCKS, older, Dining), tx2 (STARBUCKS, newer, Coffee — but assume same workspace + Dining for simplicity)
    // call findHistoryHints(workspaceId, ['starbucks'])
    // expect: { 'starbucks': { categoryId, needsConfirmation, dismissedUntil } } from newest row
    // assertion left to factories; structure-only check here
    const result = await findHistoryHints("nonexistent-ws", ["starbucks"]);
    expect(result.size).toBe(0);
  });
});
```

(Full integration test scaffolding lives in `apps/api/test/` — use whatever pattern the repo already has. If no DB-bound tests exist for categorize, dispatch a Plan-execution helper to add minimal factories; otherwise mirror the pattern in `apps/api/src/budgets/service.test.ts` or similar.)

- [ ] **Step 2: Implement `findHistoryHints`**

```ts
// apps/api/src/categorize/history-lookup.ts
import { prisma } from "../db.js";

export type HistoryHint = {
  categoryId: string;
  needsConfirmation: boolean;
  /** Future ISO date string, or null if not snoozed or expired. */
  dismissedUntil: Date | null;
};

/** For each merchantNormalized, return the most-recent categorized
 *  allocation in the workspace (single result per merchant, picked by
 *  occurredAt DESC, id ASC as tiebreaker). Excludes:
 *    - removed transactions
 *    - allocations with categoryId IS NULL
 *    - allocations whose category is archived
 *    - split transactions (alloc count != 1) */
export async function findHistoryHints(
  workspaceId: string,
  merchantsNormalized: string[],
): Promise<Map<string, HistoryHint>> {
  if (merchantsNormalized.length === 0) return new Map();

  // Single window-function query: per merchant, pick latest categorized alloc.
  const rows = await prisma.$queryRaw<Array<{
    merchantNormalized: string;
    categoryId: string;
    needsConfirmation: boolean;
    dismissedUntil: Date | null;
  }>>`
    WITH ranked AS (
      SELECT
        t."merchantNormalized" AS "merchantNormalized",
        a."categoryId" AS "categoryId",
        a."needsConfirmation" AS "needsConfirmation",
        a."dismissedUntil" AS "dismissedUntil",
        ROW_NUMBER() OVER (
          PARTITION BY t."merchantNormalized"
          ORDER BY t."occurredAt" DESC, t."id" ASC
        ) AS rn
      FROM "transactions" t
      JOIN "transaction_allocations" a ON a."transactionId" = t."id"
      JOIN "categories" c              ON c."id" = a."categoryId"
      WHERE t."workspaceId" = ${workspaceId}
        AND t."merchantNormalized" = ANY(${merchantsNormalized}::text[])
        AND t."removedAt" IS NULL
        AND a."categoryId" IS NOT NULL
        AND c."archivedAt" IS NULL
        AND (SELECT COUNT(*) FROM "transaction_allocations" x WHERE x."transactionId" = t."id") = 1
    )
    SELECT "merchantNormalized", "categoryId", "needsConfirmation", "dismissedUntil"
    FROM ranked WHERE rn = 1
  `;

  const out = new Map<string, HistoryHint>();
  for (const r of rows) {
    out.set(r.merchantNormalized, {
      categoryId: r.categoryId,
      needsConfirmation: r.needsConfirmation,
      dismissedUntil: r.dismissedUntil,
    });
  }
  return out;
}
```

- [ ] **Step 3: Run test + manual sanity check**

Run: `pnpm -F @fina/api exec vitest run src/categorize/history-lookup.test.ts`
Expected: PASS (smoke). DB integration tests in service.test.ts (Task 7) will exercise the full path.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/categorize/history-lookup.ts apps/api/src/categorize/history-lookup.test.ts
git commit -m "feat(categorize): history lookup (batch window query with archive + split filters)"
```

---

## Task 6: LLM module — PFC hint

**Files:**
- Modify: `apps/api/src/categorize/llm.ts`

- [ ] **Step 1: Extend `LLMTransaction` type**

In `apps/api/src/categorize/llm.ts`, change the type:

```ts
export type LLMTransaction = {
  id: string;
  merchantRaw: string;
  amount: number;
  occurredAtISO: string;
  /** Plaid PFC if present in rawData. Caller extracts. */
  pfc?: {
    primary: string;
    detailed: string;
    confidence: string; // "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW"
  };
};
```

- [ ] **Step 2: Include PFC in user payload (omit when missing)**

Edit the `userPayload.transactions` mapping in the same file:

```ts
    transactions: txs.map((t) => ({
      tx_id: t.id,
      merchant: t.merchantRaw,
      amount: t.amount,
      date: t.occurredAtISO,
      ...(t.pfc ? { plaid_hint: t.pfc } : {}),
    })),
```

- [ ] **Step 3: Add a sentence to systemInstruction**

```ts
      systemInstruction:
        "You categorize Canadian personal financial transactions. CAD currency. " +
        "Positive amount = expense, negative = income/refund. " +
        "Use exact category names from the categories list. If a transaction includes plaid_hint, " +
        "treat it as a strong (VERY_HIGH/HIGH) or weak (MEDIUM/LOW) hint when mapping into our category list. " +
        "If genuinely unclear, use 'Other'.",
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm -F @fina/api exec tsc --noEmit -p .`
Expected: PASS (preexisting errors unrelated).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/categorize/llm.ts
git commit -m "feat(categorize): include Plaid PFC as hint in LLM prompt (omit when missing)"
```

---

## Task 7: Categorize service — wire history + needsConfirmation + dismissedUntil

**Files:**
- Modify: `apps/api/src/categorize/service.ts`
- Test: `apps/api/src/categorize/service.test.ts`

- [ ] **Step 1: Add user mode + Other detection lookups at top of `categorizeNewTransactions`**

After Step 1's load:

```ts
  // Resolve mode for this workspace's owner (or actor — see decision: mode is User-level, applied to whoever owns the workspace's primary user — but since transactions sync runs per-workspace, look up the workspace owner's mode).
  const ownerMembership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, role: "owner" },
    select: { user: { select: { id: true, categorizationMode: true } } },
  });
  const mode = ownerMembership?.user.categorizationMode ?? "flexible";
```

(Decision note: `User.categorizationMode` is User-level; sync runs workspace-scoped so we pick the owner's mode. v2 may revisit.)

- [ ] **Step 2: Insert history lookup between mapping and LLM**

After step 2 (mapping) in `categorizeNewTransactions`, before the LLM batch:

```ts
  import { findHistoryHints } from "./history-lookup.js";
  // ...
  // After mapping pass, before LLM:
  const merchantsForHistory = [...new Set(unmapped.map((t) => t.merchantNormalized))];
  const historyHints = await findHistoryHints(workspaceId, merchantsForHistory);
  const stillUnmapped: Loaded[] = [];
  for (const t of unmapped) {
    const hint = historyHints.get(t.merchantNormalized);
    if (!hint) { stillUnmapped.push(t); continue; }

    // Resolve isOther for that category
    const cat = await prisma.category.findUnique({
      where: { id: hint.categoryId },
      select: { name: true, archivedAt: true },
    });
    if (!cat || cat.archivedAt !== null) { stillUnmapped.push(t); continue; }

    const isOther = isOtherCategory({ name: cat.name, archivedAt: cat.archivedAt });
    const needsConfirmation = computeNeedsConfirmation({
      mode,
      source: "history",
      isOther,
      priorNeedsConfirmation: hint.needsConfirmation,
    });
    const dismissedUntil =
      hint.dismissedUntil && hint.dismissedUntil.getTime() > Date.now()
        ? hint.dismissedUntil
        : null;

    // Apply via the same atomic guard as before (categoryId IS NULL AND source IS NULL)
    const tx = await prisma.transaction.findFirst({
      where: { id: t.id, workspaceId },
      include: { allocations: { select: { id: true } } },
    });
    if (!tx || tx.allocations.length !== 1) { stillUnmapped.push(t); continue; }
    const alloc = tx.allocations[0]!;
    const upd = await prisma.transactionAllocation.updateMany({
      where: { id: alloc.id, categoryId: null, source: null },
      data: { categoryId: hint.categoryId, source: "history", needsConfirmation, dismissedUntil },
    });
    if (upd.count === 0) {
      // Race: someone else categorized this allocation. Skip.
    }
  }
  if (stillUnmapped.length === 0) return;
  // 'unmapped' replaced by 'stillUnmapped' for LLM step
```

Update the LLM step downstream to use `stillUnmapped` instead of `unmapped`.

- [ ] **Step 3: Wire needsConfirmation into the LLM write**

In the existing LLM-result update, change:

```ts
      const upd = await prisma.transactionAllocation.updateMany({
        where: { id: a.id, categoryId: null, source: null },
        data: { categoryId: aiCatId, source: "ai" },
      });
```

to compute + include `needsConfirmation`:

```ts
      // Need category name to evaluate isOther
      const aiCat = await prisma.category.findUnique({
        where: { id: aiCatId },
        select: { name: true, archivedAt: true },
      });
      const isOther = aiCat ? isOtherCategory({ name: aiCat.name, archivedAt: aiCat.archivedAt }) : false;
      const needsConfirmation = computeNeedsConfirmation({ mode, source: "ai", isOther, priorNeedsConfirmation: null });

      const upd = await prisma.transactionAllocation.updateMany({
        where: { id: a.id, categoryId: null, source: null },
        data: { categoryId: aiCatId, source: "ai", needsConfirmation },
      });
```

- [ ] **Step 4: Pass PFC hint into the LLM call**

In the `llmTxs: LLMTransaction[]` mapping, extract PFC:

```ts
    const llmTxs: LLMTransaction[] = batch.map((t) => {
      const raw = (t as unknown as { rawData?: unknown }).rawData;
      const pfcRaw = (raw as { personal_finance_category?: { primary?: string; detailed?: string; confidence_level?: string } })?.personal_finance_category;
      const pfc = pfcRaw?.primary
        ? { primary: pfcRaw.primary, detailed: pfcRaw.detailed ?? "", confidence: pfcRaw.confidence_level ?? "LOW" }
        : undefined;
      return {
        id: t.id,
        merchantRaw: t.merchantRaw,
        amount: t.amount,
        occurredAtISO: t.occurredAt.toISOString().slice(0, 10),
        ...(pfc ? { pfc } : {}),
      };
    });
```

Note: `Loaded` doesn't currently carry `rawData`. Extend the type and the `loaded.push` block earlier in the same function to include `rawData: t.rawData`. (Edit `Loaded` type def + the `findMany` `select` to include `rawData: true`.)

- [ ] **Step 5: Run categorize service tests**

Run: `pnpm -F @fina/api exec vitest run src/categorize/service.test.ts`
Expected: PASS (existing) + new history tests if added.

Add new test cases for each row in the matrix (history-confirmed, history-unconfirmed × 3 modes, ai × 3 modes, Other override × 3 modes). At least 7 new cases.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/categorize/service.ts apps/api/src/categorize/service.test.ts
git commit -m "feat(categorize): pipeline wires history step + needsConfirmation + dismissedUntil"
```

---

## Task 8: Auto-promote module

**Files:**
- Create: `apps/api/src/categorize/auto-promote.ts`
- Test: `apps/api/src/categorize/auto-promote.test.ts`

- [ ] **Step 1: Write failing test (skeleton)**

```ts
// apps/api/src/categorize/auto-promote.test.ts
import { describe, it, expect } from "vitest";
import { maybeAutoPromote } from "./auto-promote.js";
// Use repo's existing DB factories for workspace + tx + allocation.

describe("maybeAutoPromote", () => {
  it("inserts merchant_mapping after 3rd confirmation with matching category", async () => {
    // setup: workspace, tx1/2/3 all STARBUCKS with cat=Coffee, all needsConfirmation=false, source=ai
    // call maybeAutoPromote(workspaceId, 'starbucks', coffeeCatId)
    // expect merchant_mappings row exists with source='auto'
  });
  it("does NOT insert when count<3", async () => { /* ... */ });
  it("excludes source='mapping' rows from count", async () => { /* ... */ });
  it("idempotent: 2nd insert is a no-op (ON CONFLICT)", async () => { /* ... */ });
});
```

- [ ] **Step 2: Implement**

```ts
// apps/api/src/categorize/auto-promote.ts
import { prisma } from "../db.js";
import { logInfo } from "../logger.js";

/** After a confirm/edit, check whether the (workspace, merchantNormalized, categoryId)
 *  tuple now has ≥3 user-confirmed allocations. If so, INSERT an explicit
 *  merchant_mapping (source='auto'). Idempotent under race (ON CONFLICT). */
export async function maybeAutoPromote(
  workspaceId: string,
  merchantNormalized: string,
  categoryId: string,
): Promise<{ promoted: boolean }> {
  // Count: same workspace + same merchantNormalized + same final categoryId
  //        where needsConfirmation=false AND source IN ('ai','history','manual')
  // 'mapping' is excluded — those rows would imply an explicit mapping already exists.
  const count = await prisma.transactionAllocation.count({
    where: {
      categoryId,
      needsConfirmation: false,
      source: { in: ["ai", "history", "manual"] },
      transaction: { workspaceId, merchantNormalized, removedAt: null },
    },
  });

  if (count < 3) return { promoted: false };

  // INSERT with ON CONFLICT DO NOTHING
  // Prisma's createMany has skipDuplicates which uses ON CONFLICT DO NOTHING.
  const insert = await prisma.merchantMapping.createMany({
    data: [{ workspaceId, merchantNormalized, categoryId, source: "auto" }],
    skipDuplicates: true,
  });

  const promoted = insert.count > 0;
  if (promoted) {
    logInfo({ workspaceId, merchantNormalized, categoryId, confirmCount: count }, "mapping.auto_promoted");
  }
  return { promoted };
}
```

- [ ] **Step 3: Run tests**

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/categorize/auto-promote.ts apps/api/src/categorize/auto-promote.test.ts
git commit -m "feat(categorize): auto-promote merchant_mapping after 3 confirms"
```

---

## Task 9: Route — `POST /workspaces/:id/transactions/:txId/confirm-category`

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Test: `apps/api/src/routes/transactions.confirm.test.ts`

- [ ] **Step 1: Add handler in `transactions.ts` (after the PATCH route)**

```ts
  app.post<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId/confirm-category",
    async (req, reply) => {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (req.params.id !== ctx.membership.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tx = await prisma.transaction.findFirst({
        where: { id: req.params.txId, workspaceId: ctx.membership.workspaceId, removedAt: null },
        include: { allocations: { select: { id: true, categoryId: true, source: true } } },
      });
      if (!tx) return reply.code(404).send({ error: "transaction_not_found" });

      // Update all allocations of this tx.
      await prisma.transactionAllocation.updateMany({
        where: { transactionId: tx.id },
        data: { needsConfirmation: false, dismissedUntil: null },
      });

      // Auto-promote if applicable (per-allocation).
      for (const a of tx.allocations) {
        if (a.categoryId && tx.merchantNormalized) {
          await maybeAutoPromote(ctx.membership.workspaceId, tx.merchantNormalized, a.categoryId);
        }
      }
      return reply.code(200).send({ ok: true });
    },
  );
```

(Import `maybeAutoPromote` at the top of `transactions.ts`. Read tx.merchantNormalized too — extend the include if needed.)

- [ ] **Step 2: Tests**

```ts
// apps/api/src/routes/transactions.confirm.test.ts
// - returns 200 + sets needsConfirmation=false
// - returns 404 for missing tx
// - returns 403 for viewer (non-editor)
// - idempotent: calling twice doesn't error
// - auto-promote fires after 3rd confirm on same (workspace, merchant, category)
```

Use the repo's existing fastify test harness (e.g. patterns under `apps/api/src/routes/*.test.ts`).

- [ ] **Step 3: Run + pass**

Run: `pnpm -F @fina/api exec vitest run src/routes/transactions.confirm.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/routes/transactions.confirm.test.ts
git commit -m "feat(api): POST /transactions/:txId/confirm-category + auto-promote trigger"
```

---

## Task 10: Route — `POST /workspaces/:id/transactions/:txId/snooze-category`

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Test: extend `apps/api/src/routes/transactions.confirm.test.ts`

- [ ] **Step 1: Handler**

```ts
  app.post<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId/snooze-category",
    async (req, reply) => {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (req.params.id !== ctx.membership.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tx = await prisma.transaction.findFirst({
        where: { id: req.params.txId, workspaceId: ctx.membership.workspaceId, removedAt: null },
        select: { id: true },
      });
      if (!tx) return reply.code(404).send({ error: "transaction_not_found" });
      const dismissedUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await prisma.transactionAllocation.updateMany({
        where: { transactionId: tx.id },
        data: { dismissedUntil },
      });
      return reply.code(200).send({ ok: true, dismissedUntil: dismissedUntil.toISOString() });
    },
  );
```

- [ ] **Step 2: Tests**

- 200 + sets dismissedUntil to ~now+7d
- needsConfirmation NOT cleared (stays true)
- 404 for missing tx
- editor required

- [ ] **Step 3: Pass + commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/routes/transactions.confirm.test.ts
git commit -m "feat(api): POST /transactions/:txId/snooze-category (7-day dismissal)"
```

---

## Task 11: Modify PATCH transaction — needsConfirmation + source=manual + dismissedUntil=NULL + auto-promote

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Test: extend `apps/api/src/routes/transactions.confirm.test.ts`

- [ ] **Step 1: In the existing PATCH handler (around line 356), when applying category changes (either tx-level `categoryId` or per-allocation patches), include the three field updates.**

Locate the update calls that set `categoryId` on `TransactionAllocation` and extend the `data` object:

```ts
        data: {
          categoryId: nextCategoryId,
          source: "manual",
          needsConfirmation: false,
          dismissedUntil: null,
        },
```

- [ ] **Step 2: After applying PATCH, trigger auto-promote per affected (merchantNormalized, categoryId)**

At the end of the PATCH handler, after the transaction is updated:

```ts
      if (tx.merchantNormalized) {
        const updated = await prisma.transactionAllocation.findMany({
          where: { transactionId: tx.id },
          select: { categoryId: true },
        });
        for (const a of updated) {
          if (a.categoryId) {
            await maybeAutoPromote(ctx.membership.workspaceId, tx.merchantNormalized, a.categoryId);
          }
        }
      }
```

- [ ] **Step 3: Tests**

- PATCH with same categoryId (no-op) → still sets source='manual' + needsConfirmation=false
- PATCH with different categoryId → updates + sets all 3 + triggers auto-promote count check
- Auto-promote does NOT fire until 3rd qualifying confirmation

- [ ] **Step 4: Pass + commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/src/routes/transactions.confirm.test.ts
git commit -m "feat(api): PATCH transaction marks allocation as user-confirmed + triggers auto-promote"
```

---

## Task 12: `PATCH /me` — accept `categorizationMode`

**Files:**
- Modify: `apps/api/src/routes/me.ts`

- [ ] **Step 1: Read existing handler at line ~161 in `apps/api/src/routes/me.ts` and add the new field to the parse + update block.**

Inside `app.patch("/me", ...)`:

```ts
        // PatchMeBody already includes categorizationMode (Task 1).
        const parsed = PatchMeBody.parse(req.body);
        // ... existing field handling ...
        if (parsed.categorizationMode !== undefined) {
          updateData.categorizationMode = parsed.categorizationMode;
        }
```

- [ ] **Step 2: Ensure GET /me returns categorizationMode in MeDTO**

Find the `GET /me` mapping where `user` is constructed, add:

```ts
        categorizationMode: user.categorizationMode,
```

- [ ] **Step 3: Tests (extend existing me.test.ts)**

- PATCH `categorizationMode: 'strict'` → 200, GET /me reflects
- Invalid value → 400 from zod
- GET /me default for new user → 'flexible'

- [ ] **Step 4: Pass + commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/routes/me.test.ts
git commit -m "feat(api): PATCH /me accepts categorizationMode + GET /me returns it"
```

---

## Task 13: Daily brief — `categorize_confirm_card` block

**Files:**
- Modify: `apps/api/src/chat/blocks.ts`
- Modify: `apps/api/src/cron/jobs/daily-brief.ts`
- Test: extend `apps/api/src/cron/jobs/daily-brief.test.ts` (create if doesn't exist)

- [ ] **Step 1: Mirror new block on API side**

In `apps/api/src/chat/blocks.ts`, add:

```ts
export type CategorizeConfirmCardBlock = {
  type: "categorize_confirm_card";
  count: number;
  items: { txId: string; merchant: string; categoryName: string }[];
  moreCount: number;
};

export type PresentationBlock = TextBlock | ConfirmCardBlock | CategorizeConfirmCardBlock;
```

- [ ] **Step 2: Compute window cap + count in `daily-brief.ts` per user**

Inside the per-user loop in `runDailyBrief`, after generateBrief but before brief insert:

```ts
import { buildCategorizeConfirmCard } from "./categorize-confirm-card.js"; // optional: extract for testability
// ...
// After: const blocks = await generateBrief(...);
const mode = (await prisma.user.findUnique({
  where: { id: u.id },
  select: { categorizationMode: true },
}))?.categorizationMode ?? "flexible";
if (mode !== "auto") {
  const lastBriefAt = await prisma.brief.aggregate({
    where: { userId: u.id },
    _max: { createdAt: true },
  });
  const since = new Date(Math.max(
    lastBriefAt._max.createdAt?.getTime() ?? 0,
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ));
  const cardRows = await prisma.transactionAllocation.findMany({
    where: {
      needsConfirmation: true,
      OR: [{ dismissedUntil: null }, { dismissedUntil: { lt: new Date() } }],
      transaction: {
        removedAt: null,
        workspace: { memberships: { some: { userId: u.id } } },
        createdAt: { gte: since },
      },
    },
    take: 6, // we'll show up to 5 and use the 6th to know if more exists, but use count() below to be accurate
    select: {
      transaction: { select: { id: true, merchantRaw: true, merchantNormalized: true } },
      category: { select: { name: true } },
    },
    orderBy: { transaction: { occurredAt: "desc" } },
  });
  const totalCount = await prisma.transactionAllocation.count({
    where: {
      needsConfirmation: true,
      OR: [{ dismissedUntil: null }, { dismissedUntil: { lt: new Date() } }],
      transaction: {
        removedAt: null,
        workspace: { memberships: { some: { userId: u.id } } },
        createdAt: { gte: since },
      },
    },
  });
  if (totalCount > 0) {
    const items = cardRows.slice(0, 5).map((r) => ({
      txId: r.transaction.id,
      merchant: r.transaction.merchantNormalized ?? r.transaction.merchantRaw,
      categoryName: r.category?.name ?? "Unknown",
    }));
    blocks.push({
      type: "categorize_confirm_card",
      count: totalCount,
      items,
      moreCount: Math.max(0, totalCount - items.length),
    });
  }
}
```

- [ ] **Step 3: Tests**

- needsConfirmation 0 → card absent
- needsConfirmation 3 → card present, count=3, items=3, moreCount=0
- needsConfirmation 7 → card.count=7, items=5, moreCount=2
- dismissedUntil > now → excluded
- Auto mode → card absent
- lastBriefAt 30 days ago → window cap 7d applies (only last 7d included)

- [ ] **Step 4: Pass + commit**

```bash
git add apps/api/src/chat/blocks.ts apps/api/src/cron/jobs/daily-brief.ts apps/api/src/cron/jobs/daily-brief.test.ts
git commit -m "feat(brief): categorize_confirm_card block (window cap + snooze exclusion + auto mode skip)"
```

---

## Task 14: Telemetry events

**Files:**
- Create: `apps/api/src/telemetry/categorize.ts`
- Modify call sites in: `apps/api/src/categorize/service.ts`, `apps/api/src/routes/transactions.ts`

- [ ] **Step 1: Create thin wrappers**

```ts
// apps/api/src/telemetry/categorize.ts
import { logInfo } from "../logger.js";

export function emitCategorizeCompleted(args: {
  workspaceId: string;
  source: "mapping" | "history" | "ai";
  categoryName: string;
  pfcPrimary: string | null;
  pfcConfidence: string | null;
  pfcMissing: boolean;
}) {
  logInfo({ event: "categorize.completed", ...args }, "categorize.completed");
}

export function emitCategorizeConfirmed(args: {
  workspaceId: string;
  source: "mapping" | "history" | "ai" | "manual";
  action: "confirm" | "edit" | "snooze";
}) {
  logInfo({ event: "categorize.confirmed", ...args }, "categorize.confirmed");
}
```

(`mapping.auto_promoted` already emitted by `auto-promote.ts` — no change needed.)

- [ ] **Step 2: Call `emitCategorizeCompleted` from each branch in `categorize/service.ts`**

After each successful write (mapping branch, history branch, ai branch), call `emitCategorizeCompleted` with the appropriate source.

- [ ] **Step 3: Call `emitCategorizeConfirmed` from confirm / snooze / PATCH routes**

In each route, after the successful write, call with the right action.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/telemetry/categorize.ts apps/api/src/categorize/service.ts apps/api/src/routes/transactions.ts
git commit -m "feat(telemetry): categorize.completed / .confirmed events"
```

---

## Task 15: Mobile — `/categorization` mode setting screen

**Files:**
- Create: `apps/mobile/app/categorization/index.tsx`

- [ ] **Step 1: Build the screen using existing Settings patterns from `/notifications`**

```tsx
// apps/mobile/app/categorization/index.tsx
import { useEffect, useState } from "react";
import { ScrollView, View, Text, Pressable, StyleSheet, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { MeDTO, CategorizationMode } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

const MODES: { key: CategorizationMode; title: string; sub: string }[] = [
  { key: "flexible", title: "Flexible", sub: "New merchants only get one confirm. Skip is fine." },
  { key: "strict",   title: "Strict",   sub: "Every merchant needs a confirm before it auto-categorizes." },
  { key: "auto",     title: "Auto",     sub: "Never asks. Fix wrong categories yourself." },
];

export default function CategorizationSettings() {
  const [me, setMe] = useState<MeDTO | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<MeDTO>("/me").then(setMe).catch(() => {});
  }, []);

  async function setMode(mode: CategorizationMode) {
    if (saving || !me) return;
    setSaving(true);
    try {
      const next = await apiFetch<MeDTO>("/me", {
        method: "PATCH",
        body: JSON.stringify({ categorizationMode: mode }),
      });
      setMe(next);
    } catch (e) {
      Alert.alert("Couldn't save", (e as { code?: string }).code ?? "Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton name="chevron-back" onPress={() => router.back()} />
        <Text style={styles.title}>Categorization style</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        {MODES.map((m) => {
          const selected = me?.user.categorizationMode === m.key;
          return (
            <Pressable
              key={m.key}
              style={[styles.card, selected && styles.cardSelected]}
              onPress={() => setMode(m.key)}
              disabled={saving}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{m.title}</Text>
                <Text style={styles.cardSub}>{m.sub}</Text>
              </View>
              {selected && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
            </Pressable>
          );
        })}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.base, gap: space.sm, height: 56 },
  title: { ...type$.titleMd, color: colors.ink },
  scroll: { padding: space.lg, gap: space.sm },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 14,
    padding: space.base,
  },
  cardSelected: { borderColor: colors.primary },
  cardTitle: { ...type$.titleSm, color: colors.ink, marginBottom: 4 },
  cardSub: { ...type$.bodySm, color: colors.body },
});
```

- [ ] **Step 2: Verify build (no test for static screen)**

Run mobile typecheck. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/categorization/index.tsx
git commit -m "feat(mobile): /categorization mode setting screen"
```

---

## Task 16: Mobile — More tab row restoration

**Files:**
- Modify: `apps/mobile/app/(tabs)/more.tsx`

- [ ] **Step 1: Add the "Categorization style" row back to the AI group**

In the AI group (after Notifications row), add:

```tsx
          <SettingsRow
            icon="construct-outline"
            title="Categorization style"
            detail={modeLabel(me)}
            onPress={() => router.push("/categorization" as never)}
            last
          />
```

Add `modeLabel` helper near `briefSubtitle`:

```ts
function modeLabel(me: MeDTO | null): string {
  if (!me) return "—";
  switch (me.user.categorizationMode) {
    case "strict":   return "Strict";
    case "flexible": return "Flexible";
    case "auto":     return "Auto";
  }
}
```

Also change the prior `last` row to no longer have `last={true}` (since this is now the last).

- [ ] **Step 2: Verify mobile typecheck**

Run: `pnpm typecheck` (mobile section).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/(tabs)/more.tsx
git commit -m "feat(mobile): restore Categorization style row pointing at /categorization"
```

---

## Task 17: Mobile — `NeedsReviewPill` component

**Files:**
- Create: `apps/mobile/src/categorize/NeedsReviewPill.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/mobile/src/categorize/NeedsReviewPill.tsx
import { Text, Pressable, StyleSheet } from "react-native";
import { colors, type as type$ } from "../design/tokens";

export function NeedsReviewPill({
  isOther,
  onPress,
}: {
  isOther: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      style={[styles.pill, isOther ? styles.pillOther : styles.pillNormal]}
    >
      <Text style={[styles.text, isOther ? styles.textOther : styles.textNormal]}>
        Needs review
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: colors.surfaceSoft,
  },
  pillNormal: { borderColor: colors.accentYellow },
  pillOther:  { borderColor: colors.down },
  text: { ...type$.captionStrong },
  textNormal: { color: colors.accentYellow },
  textOther:  { color: colors.down },
});
```

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/src/categorize/NeedsReviewPill.tsx
git commit -m "feat(mobile): NeedsReviewPill component"
```

---

## Task 18: Mobile — `ConfirmSheet` bottom sheet + Activity tab integration

**Files:**
- Create: `apps/mobile/src/categorize/ConfirmSheet.tsx`
- Modify: `apps/mobile/app/(tabs)/activity.tsx`

- [ ] **Step 1: Create the bottom sheet**

```tsx
// apps/mobile/src/categorize/ConfirmSheet.tsx
import { useCallback, useMemo, useRef, useEffect } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { colors, space, type as type$ } from "../design/tokens";
import { apiFetch } from "../api/client";

export function ConfirmSheet({
  visible,
  workspaceId,
  txId,
  merchant,
  categoryName,
  onClose,
  onConfirmed,
  onEditPress,
}: {
  visible: boolean;
  workspaceId: string;
  txId: string;
  merchant: string;
  categoryName: string;
  onClose: () => void;
  onConfirmed: () => void;
  onEditPress: () => void;
}) {
  const ref = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ["28%"], []);
  const didExplicit = useRef(false);

  useEffect(() => {
    if (visible) {
      didExplicit.current = false;
      ref.current?.expand();
    } else {
      ref.current?.close();
    }
  }, [visible]);

  const onChange = useCallback(async (index: number) => {
    if (index === -1 && visible && !didExplicit.current) {
      // sheet closed without explicit confirm/edit → snooze
      try {
        await apiFetch(`/workspaces/${workspaceId}/transactions/${txId}/snooze-category`, { method: "POST" });
      } catch { /* swallow */ }
      onClose();
    }
  }, [visible, workspaceId, txId, onClose]);

  async function confirm() {
    didExplicit.current = true;
    try {
      await apiFetch(`/workspaces/${workspaceId}/transactions/${txId}/confirm-category`, { method: "POST" });
      onConfirmed();
      ref.current?.close();
    } catch { /* ... */ }
  }

  function pickOther() {
    didExplicit.current = true;
    ref.current?.close();
    onEditPress();
  }

  return (
    <BottomSheet ref={ref} index={-1} snapPoints={snapPoints} enablePanDownToClose onChange={onChange}>
      <BottomSheetView style={styles.body}>
        <Text style={styles.q}>{merchant} → {categoryName} 이 맞아요?</Text>
        <View style={styles.row}>
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={confirm}>
            <Text style={styles.btnPrimaryText}>Confirm</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={pickOther}>
            <Text style={styles.btnGhostText}>다른 카테고리</Text>
          </Pressable>
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.base },
  q: { ...type$.titleSm, color: colors.ink, textAlign: "center" },
  row: { flexDirection: "row", gap: space.sm },
  btn: { flex: 1, height: 48, alignItems: "center", justifyContent: "center", borderRadius: 12 },
  btnPrimary: { backgroundColor: colors.primary },
  btnPrimaryText: { ...type$.bodyMdStrong, color: colors.onPrimary },
  btnGhost: { borderWidth: 1, borderColor: colors.hairline },
  btnGhostText: { ...type$.bodyMd, color: colors.ink },
});
```

- [ ] **Step 2: Wire Activity tab rows**

In `apps/mobile/app/(tabs)/activity.tsx`, for each transaction row, render the pill when `allocation.needsConfirmation` is true and `dismissedUntil` is null/past. Tap → opens ConfirmSheet with that row's allocation data. Use existing CategoryPickerSheet for the "다른 카테고리" flow.

(Find the existing row map. Add a state `confirmTarget` and render `<ConfirmSheet visible={!!confirmTarget} ... />` once at the screen level.)

- [ ] **Step 3: Verify with manual run**

Start mobile dev server. Open Activity tab. Verify:
- A transaction with `needsConfirmation=true` shows the pill.
- Tap pill → sheet opens.
- Confirm → pill disappears, GET /me-or-transactions reflects.
- Swipe down → POST snooze fires, pill disappears.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/categorize/ConfirmSheet.tsx apps/mobile/app/(tabs)/activity.tsx
git commit -m "feat(mobile): ConfirmSheet + Activity tab pill integration (confirm/edit/snooze)"
```

---

## Task 19: Mobile — `categorize_confirm_card` renderer

**Files:**
- Modify: `apps/mobile/src/chat/PresentationBlock.tsx`

- [ ] **Step 1: Add a case in the render switch**

```tsx
  if (block.type === "categorize_confirm_card") {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>오늘 분류한 {block.count}개 확인해주세요</Text>
        {block.items.map((it) => (
          <Text key={it.txId} style={styles.item}>
            {it.merchant} → {it.categoryName}
          </Text>
        ))}
        {block.moreCount > 0 && <Text style={styles.more}>외 {block.moreCount}건</Text>}
        <Pressable style={styles.cta} onPress={() => router.push("/(tabs)/activity" as never)}>
          <Text style={styles.ctaText}>Activity에서 보기</Text>
        </Pressable>
      </View>
    );
  }
```

(Adjust styles to match the existing card styling in the file.)

- [ ] **Step 2: Mobile typecheck**

Run: `pnpm typecheck`. Mobile passes.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/chat/PresentationBlock.tsx
git commit -m "feat(mobile): categorize_confirm_card renderer in PresentationBlock"
```

---

## Self-review checklist

- Spec §Pipeline (mapping/history/LLM) → Tasks 5, 6, 7
- Spec §Mode setting + DB column → Tasks 1, 2, 12, 15, 16
- Spec §needsConfirmation rule → Task 3 (helper) + Task 7 (wiring)
- Spec §Snooze (7d) → Task 10 (route) + Task 18 (sheet) + Task 7 (history inherit)
- Spec §Auto-promote → Task 8 + auto-promote calls from Tasks 9, 11
- Spec §Confirm UX (Activity pill, sheet, brief card) → Tasks 17, 18, 19 + Task 13
- Spec §Daily brief window cap → Task 13
- Spec §Migrations → Task 2
- Spec §AllocationDTO/MeDTO/PresentationBlock changes → Task 1
- Spec §Telemetry → Task 14
- Spec §Testing matrix → Tasks 3, 4, 5, 7, 8, 9, 10, 11, 12, 13

No placeholders. No TBDs. All code blocks are full implementations or full diffs.

Type consistency check: `CategorizationMode`/`CategorizationSource`/`AllocationDTO`/`MeDTO.user`/`PresentationBlock` names match across Task 1 (shared lib), Task 2 (Prisma enum), and all consumer tasks.
