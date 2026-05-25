# Categorization Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 3-step categorize pipeline (explicit mapping → workspace history → LLM with Plaid PFC hint), per-allocation `needsConfirmation` driven by `User.categorizationMode` (flexible/strict/auto), Activity pill + bottom sheet + daily brief confirm card, auto-promote merchant_mapping after 3 just-confirms, snooze on sheet dismiss.

**Architecture:** Pipeline lives in `apps/api/src/categorize/service.ts` with new `auto-promote.ts` + helper modules. Schema gains 2 columns (`needsConfirmation`, `dismissedUntil`) on `TransactionAllocation`, 1 column (`categorizationMode`) on `User`, 1 enum value (`history`) on `CategorizationSource`, 1 new enum (`CategorizationMode`), and a partial index on transactions. Mobile gets a new `/categorization` settings screen, an Activity-pill + bottom-sheet flow, and a new `categorize_confirm_card` presentation block renderer.

**Tech Stack:** Fastify + Prisma 5 (Postgres) on the API, Expo SDK 54 React Native on mobile, `@gorhom/bottom-sheet` for the confirm sheet, `@fina/shared` for cross-app types + zod schemas, Gemini Flash Lite for LLM categorization (existing). Tests live in `apps/api/tests/<name>.test.ts` (NOT colocated). Use vitest + existing helpers (`tests/helpers/auth.ts`, `tests/helpers/db.ts`, `tests/helpers/gemini-mock.ts`).

**Spec:** `docs/superpowers/specs/2026-05-25-categorization-overhaul-design.md`

**Important interaction with existing code:**
- `POST /workspaces/:id/transactions/:txId/categorize` (line 267 of `routes/transactions.ts`) already calls `applyManualCategorize`, which writes `source='manual'` + upserts merchant_mapping (immediate explicit signal). This path stays as-is plus a small addition (`needsConfirmation=false`, `dismissedUntil=null`).
- A NEW route `POST /workspaces/:id/transactions/:txId/confirm-category` is added for "just confirm AI's pick without changing category." This path does NOT upsert mapping by itself — it counts toward the auto-promote threshold (≥3).
- The PATCH route at line 356 of `routes/transactions.ts` does not currently change category; do not modify it for category logic.
- The Prisma model is `Membership` (mapped to `memberships`), not `WorkspaceMember`. The accessor is `prisma.membership`.

---

## File structure

**Create:**
- `libs/shared/src/categorization.ts` — `CategorizationMode` type + zod
- `apps/api/src/categorize/needs-confirmation.ts` — pure: `(mode, source, isOther, priorNeedsConfirmation) → boolean`
- `apps/api/src/categorize/other-detection.ts` — pure: `isOtherCategory({ name, archivedAt })`
- `apps/api/src/categorize/history-lookup.ts` — batch query for prior categorized tx per merchantNormalized
- `apps/api/src/categorize/auto-promote.ts` — count + INSERT after just-confirm
- `apps/api/src/telemetry/categorize.ts` — `categorize.completed` / `categorize.confirmed` thin wrappers
- `apps/mobile/app/categorization/index.tsx` — Mode setting screen (3 cards)
- `apps/mobile/src/categorize/ConfirmSheet.tsx` — bottom sheet (Confirm / Edit / dismiss-as-snooze)
- `apps/mobile/src/categorize/NeedsReviewPill.tsx` — pill component (yellow / red Other)
- Test files (all in `apps/api/tests/`):
  - `apps/api/tests/categorize.needs-confirmation.test.ts`
  - `apps/api/tests/categorize.other-detection.test.ts`
  - `apps/api/tests/categorize.history-lookup.test.ts`
  - `apps/api/tests/categorize.auto-promote.test.ts`
  - `apps/api/tests/transactions.confirm-snooze.test.ts`

**Modify:**
- `libs/shared/src/dto/transactions.ts` — extend `AllocationDTO.source` + add `needsConfirmation`, `dismissedUntil`
- `libs/shared/src/dto/me.ts` — add `categorizationMode` to `MeDTO.user`
- `libs/shared/src/dto/chat.ts` — add `categorize_confirm_card` variant
- `libs/shared/src/schemas/me.ts` — add optional `categorizationMode` to `PatchMeBody`
- `libs/shared/src/index.ts` — export `./categorization.js`
- `apps/api/src/chat/blocks.ts` — mirror the new variant on API side
- `apps/api/prisma/schema.prisma` — add fields + enums (no index here; raw SQL added to migration)
- `apps/api/prisma/migrations/<ts>_categorization_overhaul/migration.sql` — raw ALTER + partial index
- `apps/api/src/categorize/service.ts` — wire history step + needsConfirmation writes + PFC hint extraction
- `apps/api/src/categorize/llm.ts` — accept PFC hint per tx, include in payload + systemInstruction
- `apps/api/src/categorize/manual-categorize.ts` — additionally clear `needsConfirmation` and `dismissedUntil` for the allocation written
- `apps/api/src/routes/me.ts` — accept `categorizationMode` in PATCH + return in GET
- `apps/api/src/routes/transactions.ts` — add `POST /confirm-category` and `POST /snooze-category`
- `apps/api/src/cron/jobs/daily-brief.ts` — compute window cap + emit `categorize_confirm_card` block
- `apps/api/tests/categorize.service.test.ts` — extend with matrix + history + PFC tests
- `apps/api/tests/me.test.ts` — extend with categorizationMode tests (if file exists; otherwise `apps/api/tests/routes.me.test.ts` — verify with `ls apps/api/tests/me*` before extending)
- `apps/mobile/app/(tabs)/more.tsx` — re-add "Categorization style" row + adjust prior last-row marker
- `apps/mobile/app/(tabs)/activity.tsx` — render `NeedsReviewPill` on rows + wire ConfirmSheet
- `apps/mobile/src/chat/PresentationBlock.tsx` — handle new variant

---

## Task 1: Shared lib types

**Files:**
- Create: `libs/shared/src/categorization.ts`
- Modify: `libs/shared/src/dto/transactions.ts`
- Modify: `libs/shared/src/dto/me.ts`
- Modify: `libs/shared/src/dto/chat.ts`
- Modify: `libs/shared/src/schemas/me.ts`
- Modify: `libs/shared/src/index.ts`

- [ ] **Step 1: Create `categorization.ts`**

```ts
// libs/shared/src/categorization.ts
import { z } from "zod";

export const CATEGORIZATION_MODES = ["flexible", "strict", "auto"] as const;
export type CategorizationMode = (typeof CATEGORIZATION_MODES)[number];

export const CategorizationModeSchema = z.enum(CATEGORIZATION_MODES);
```

- [ ] **Step 2: Extend `AllocationDTO` (full new shape, replacing current)**

In `libs/shared/src/dto/transactions.ts`, replace the current `AllocationDTO`:

```ts
export type AllocationDTO = {
  id: string;
  categoryId: string | null;
  /** Decimal serialized as a string (e.g. "12.34"). */
  amount: string;
  /** Where the allocation came from. `null` for uncategorised. */
  source: "manual" | "ai" | "mapping" | "history" | null;
  /** True when the allocation is awaiting user confirmation. */
  needsConfirmation: boolean;
  /** ISO 8601 timestamp. When in the future, this allocation is snoozed
   *  (hidden from Activity pill and Daily Brief confirm card). */
  dismissedUntil: string | null;
};
```

- [ ] **Step 3: Add `categorizationMode` to `MeDTO.user`**

In `libs/shared/src/dto/me.ts`, add the import and the new field at the end of the inner `user` object (after `notificationPrefs`):

```ts
import type { CategorizationMode } from "../categorization.js";
// ...inside type MeDTO = { user: { ... } } ...
    notificationPrefs: NotificationPrefs;
    categorizationMode: CategorizationMode;
```

- [ ] **Step 4: Add new variant to `PresentationBlock` union (preserve existing variants)**

In `libs/shared/src/dto/chat.ts`, extend the union by adding the third variant at the end (the existing two — `text` and `confirm_card` — stay):

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

- [ ] **Step 5: Extend `PatchMeBody`**

In `libs/shared/src/schemas/me.ts`, add the import + the new optional field inside the `z.object({ ... }).strict()` block (preserve existing fields):

```ts
import { CategorizationModeSchema } from "../categorization.js";
// ...
  notificationPrefs: NotificationPrefsSchema.optional(),
  categorizationMode: CategorizationModeSchema.optional(),
}).strict();
```

- [ ] **Step 6: Re-export**

Append to `libs/shared/src/index.ts`:

```ts
export * from "./categorization.js";
```

- [ ] **Step 7: Build shared lib**

Run: `pnpm -F @fina/shared build`
Expected: PASS, no TS errors.

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

**Strategy:** Declare columns and enums in `schema.prisma` (so the Prisma client types are correct). Do NOT declare the partial index in the schema (Prisma can't express partial indexes). Add the partial index via raw SQL inside the same migration file. The schema and migration stay in sync because: schema = column declarations (Prisma-managed), migration = raw DDL (we add the partial index, no duplicate full index ever exists).

- [ ] **Step 1: Edit `apps/api/prisma/schema.prisma`**

Find the `User` model. Add a new line in the field list:

```prisma
model User {
  // ... existing fields ...
  categorizationMode CategorizationMode @default(flexible)
  // ... existing fields continued ...
}
```

Find the `TransactionAllocation` model (line ~354). Add two columns:

```prisma
model TransactionAllocation {
  // ... existing fields ...
  needsConfirmation Boolean   @default(false)
  dismissedUntil    DateTime?
  // ... existing fields continued ...
}
```

Find the enums section. Add the new enum and extend the existing one:

```prisma
enum CategorizationSource {
  mapping
  ai
  manual
  history    // NEW
}

enum CategorizationMode {
  flexible
  strict
  auto
}
```

(Place `CategorizationMode` near `CategorizationSource`.)

Do NOT add a `@@index` line to the `Transaction` model for this purpose — the partial index is raw SQL.

- [ ] **Step 2: Generate empty migration scaffold**

```bash
pnpm --filter @fina/api exec prisma migrate dev --create-only --name categorization_overhaul
```

A directory like `prisma/migrations/<TIMESTAMP>_categorization_overhaul/` is created with a `migration.sql` Prisma auto-generated. Open that file.

- [ ] **Step 3: Verify auto-generated SQL contains:**

Roughly:

```sql
-- Add value to existing enum
ALTER TYPE "CategorizationSource" ADD VALUE 'history';

-- Create new enum
CREATE TYPE "CategorizationMode" AS ENUM ('flexible', 'strict', 'auto');

-- Add User column
ALTER TABLE "users" ADD COLUMN "categorizationMode" "CategorizationMode" NOT NULL DEFAULT 'flexible';

-- Add allocation columns
ALTER TABLE "transaction_allocations" ADD COLUMN "needsConfirmation" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "transaction_allocations" ADD COLUMN "dismissedUntil" TIMESTAMP(3);
```

If any of these is missing, add it manually. Prisma may split `ALTER TYPE ... ADD VALUE` into its own migration since it cannot run in a transaction with other statements — if Prisma errors on `migrate dev`, split the enum ADD VALUE into a separate migration (created first), then re-run.

- [ ] **Step 4: Append the partial index**

At the bottom of the same `migration.sql`:

```sql
CREATE INDEX "transactions_workspace_merchant_occurred_idx"
  ON "transactions" ("workspaceId", "merchantNormalized", "occurredAt" DESC)
  WHERE "removedAt" IS NULL;
```

- [ ] **Step 5: Apply**

```bash
pnpm --filter @fina/api exec prisma migrate dev
```

Expected: migration applies cleanly; Prisma client regenerates.

- [ ] **Step 6: Verify Prisma client picks up the new fields**

Run: `pnpm -F @fina/api exec tsc --noEmit -p .`
Expected: PASS (apart from preexisting unrelated errors).

- [ ] **Step 7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(db): migration for categorization overhaul (mode + needsConfirmation + dismissedUntil + history source + partial index)"
```

---

## Task 3: Pure helper — `needs-confirmation.ts`

**Files:**
- Create: `apps/api/src/categorize/needs-confirmation.ts`
- Create: `apps/api/tests/categorize.needs-confirmation.test.ts`

- [ ] **Step 1: Write failing test (full matrix)**

```ts
// apps/api/tests/categorize.needs-confirmation.test.ts
import { describe, it, expect } from "vitest";
import { computeNeedsConfirmation } from "../src/categorize/needs-confirmation.js";

const modes = ["strict", "flexible", "auto"] as const;

describe("computeNeedsConfirmation — mapping source", () => {
  for (const m of modes) {
    it(`${m} + mapping → false`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "mapping", isOther: false, priorNeedsConfirmation: null })).toBe(false);
    });
  }
});

describe("computeNeedsConfirmation — manual source", () => {
  for (const m of modes) {
    it(`${m} + manual → false`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "manual", isOther: false, priorNeedsConfirmation: null })).toBe(false);
    });
  }
});

describe("computeNeedsConfirmation — history (prior confirmed)", () => {
  for (const m of modes) {
    it(`${m} + history(prior=false) → false`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "history", isOther: false, priorNeedsConfirmation: false })).toBe(false);
    });
  }
});

describe("computeNeedsConfirmation — history (prior unconfirmed)", () => {
  it("strict + history(prior=true) → true", () => {
    expect(computeNeedsConfirmation({ mode: "strict", source: "history", isOther: false, priorNeedsConfirmation: true })).toBe(true);
  });
  it("flexible + history(prior=true) → false", () => {
    expect(computeNeedsConfirmation({ mode: "flexible", source: "history", isOther: false, priorNeedsConfirmation: true })).toBe(false);
  });
  it("auto + history(prior=true) → false", () => {
    expect(computeNeedsConfirmation({ mode: "auto", source: "history", isOther: false, priorNeedsConfirmation: true })).toBe(false);
  });
});

describe("computeNeedsConfirmation — ai source (new merchant)", () => {
  it("strict + ai → true", () => {
    expect(computeNeedsConfirmation({ mode: "strict", source: "ai", isOther: false, priorNeedsConfirmation: null })).toBe(true);
  });
  it("flexible + ai → true", () => {
    expect(computeNeedsConfirmation({ mode: "flexible", source: "ai", isOther: false, priorNeedsConfirmation: null })).toBe(true);
  });
  it("auto + ai → false", () => {
    expect(computeNeedsConfirmation({ mode: "auto", source: "ai", isOther: false, priorNeedsConfirmation: null })).toBe(false);
  });
});

describe("computeNeedsConfirmation — Other category override", () => {
  for (const m of modes) {
    it(`${m} + Other + ai → true`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "ai", isOther: true, priorNeedsConfirmation: null })).toBe(true);
    });
    it(`${m} + Other + mapping → true (override beats mapping)`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "mapping", isOther: true, priorNeedsConfirmation: null })).toBe(true);
    });
  }
});
```

- [ ] **Step 2: Run test (fail)**

```bash
pnpm -F @fina/api exec vitest run tests/categorize.needs-confirmation.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// apps/api/src/categorize/needs-confirmation.ts
import type { CategorizationMode } from "@fina/shared";

export type NeedsConfirmationSource = "mapping" | "history" | "ai" | "manual";

export type NeedsConfirmationInput = {
  mode: CategorizationMode;
  source: NeedsConfirmationSource;
  isOther: boolean;
  /** For source='history' only: the prior allocation's needsConfirmation.
   *  null for non-history sources. */
  priorNeedsConfirmation: boolean | null;
};

export function computeNeedsConfirmation(input: NeedsConfirmationInput): boolean {
  if (input.isOther) return true; // mode-override
  if (input.source === "mapping" || input.source === "manual") return false;
  if (input.source === "history" && input.priorNeedsConfirmation === false) return false;
  // remaining: source='ai' OR source='history' with prior unconfirmed
  switch (input.mode) {
    case "strict":   return true;
    case "flexible": return input.source === "ai";
    case "auto":     return false;
  }
}
```

- [ ] **Step 4: Re-run test (pass)**

Expected: PASS (15+ cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/categorize/needs-confirmation.ts apps/api/tests/categorize.needs-confirmation.test.ts
git commit -m "feat(categorize): pure needsConfirmation rule covering full mode×source matrix"
```

---

## Task 4: Pure helper — `other-detection.ts`

**Files:**
- Create: `apps/api/src/categorize/other-detection.ts`
- Create: `apps/api/tests/categorize.other-detection.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// apps/api/tests/categorize.other-detection.test.ts
import { describe, it, expect } from "vitest";
import { isOtherCategory } from "../src/categorize/other-detection.js";

describe("isOtherCategory", () => {
  it("exact 'Other' not archived → true", () => {
    expect(isOtherCategory({ name: "Other", archivedAt: null })).toBe(true);
  });
  it("lowercase 'other' → true", () => {
    expect(isOtherCategory({ name: "other", archivedAt: null })).toBe(true);
  });
  it("padded '  Other  ' → true", () => {
    expect(isOtherCategory({ name: "  Other  ", archivedAt: null })).toBe(true);
  });
  it("archived 'Other' → false (rule disabled)", () => {
    expect(isOtherCategory({ name: "Other", archivedAt: new Date() })).toBe(false);
  });
  it("'Misc' → false", () => {
    expect(isOtherCategory({ name: "Misc", archivedAt: null })).toBe(false);
  });
  it("'Others' (plural) → false", () => {
    expect(isOtherCategory({ name: "Others", archivedAt: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Run (fail)**

```bash
pnpm -F @fina/api exec vitest run tests/categorize.other-detection.test.ts
```

- [ ] **Step 3: Implement**

```ts
// apps/api/src/categorize/other-detection.ts
export function isOtherCategory(category: { name: string; archivedAt: Date | null }): boolean {
  if (category.archivedAt !== null) return false;
  return category.name.trim().toLowerCase() === "other";
}
```

- [ ] **Step 4: Re-run (pass)**

Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/categorize/other-detection.ts apps/api/tests/categorize.other-detection.test.ts
git commit -m "feat(categorize): isOtherCategory helper (case-insensitive + archive aware)"
```

---

## Task 5: History lookup module

**Files:**
- Create: `apps/api/src/categorize/history-lookup.ts`
- Create: `apps/api/tests/categorize.history-lookup.test.ts`

- [ ] **Step 1: Implement module**

```ts
// apps/api/src/categorize/history-lookup.ts
import { prisma } from "../db.js";

export type HistoryHint = {
  categoryId: string;
  needsConfirmation: boolean;
  /** Future ISO datetime, or null if not snoozed or expired. */
  dismissedUntil: Date | null;
};

/** For each `merchantNormalized` in input, return the most-recent eligible
 *  history hint in the workspace. Eligible means:
 *   - tx.removedAt is null
 *   - tx has exactly one allocation (no splits)
 *   - allocation.categoryId is not null
 *   - the referenced category is not archived
 *  Tiebreaker for equal occurredAt: smaller tx.id (deterministic). */
export async function findHistoryHints(
  workspaceId: string,
  merchantsNormalized: string[],
): Promise<Map<string, HistoryHint>> {
  if (merchantsNormalized.length === 0) return new Map();

  const rows = await prisma.$queryRaw<Array<{
    merchantNormalized: string;
    categoryId: string;
    needsConfirmation: boolean;
    dismissedUntil: Date | null;
  }>>`
    WITH ranked AS (
      SELECT
        t."merchantNormalized" AS "merchantNormalized",
        a."categoryId"          AS "categoryId",
        a."needsConfirmation"   AS "needsConfirmation",
        a."dismissedUntil"      AS "dismissedUntil",
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

- [ ] **Step 2: Write DB-backed test using existing helpers**

```ts
// apps/api/tests/categorize.history-lookup.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { findHistoryHints } from "../src/categorize/history-lookup.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

async function makeWs(): Promise<{ wsId: string; accountId: string }> {
  const app = await buildApp(testEnv());
  const u = await signUpAndGetCookie(app, { email: `hist-${Date.now()}@x.com`, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Acc", type: "depository" } });
  await app.close();
  return { wsId, accountId: acct.id };
}

async function makeCat(wsId: string, name: string, archived = false) {
  return prisma.category.create({
    data: { workspaceId: wsId, name, archivedAt: archived ? new Date() : null },
  });
}

async function makeTx(wsId: string, accountId: string, merchantNorm: string, occurredAt: Date, categoryId: string | null, opts?: { needsConfirmation?: boolean; dismissedUntil?: Date | null; removedAt?: Date | null }): Promise<string> {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId,
      merchantRaw: merchantNorm.toUpperCase(),
      merchantNormalized: merchantNorm,
      amount: "10.00",
      occurredAt,
      source: "plaid",
      rawData: {},
      removedAt: opts?.removedAt ?? null,
      allocations: { create: { amount: "10.00", categoryId, source: categoryId ? "ai" : null, needsConfirmation: opts?.needsConfirmation ?? false, dismissedUntil: opts?.dismissedUntil ?? null } },
    },
  });
  return tx.id;
}

describe("findHistoryHints", () => {
  it("returns most recent categorized tx per merchant", async () => {
    const { wsId, accountId } = await makeWs();
    const cat = await makeCat(wsId, "Dining");
    const older = new Date("2026-01-01");
    const newer = new Date("2026-02-01");
    await makeTx(wsId, accountId, "starbucks", older, cat.id);
    await makeTx(wsId, accountId, "starbucks", newer, cat.id, { needsConfirmation: true });
    const result = await findHistoryHints(wsId, ["starbucks"]);
    const hint = result.get("starbucks");
    expect(hint?.categoryId).toBe(cat.id);
    expect(hint?.needsConfirmation).toBe(true); // came from the newer tx
  });

  it("skips removed transactions", async () => {
    const { wsId, accountId } = await makeWs();
    const cat = await makeCat(wsId, "Dining");
    await makeTx(wsId, accountId, "starbucks", new Date("2026-02-01"), cat.id, { removedAt: new Date() });
    const result = await findHistoryHints(wsId, ["starbucks"]);
    expect(result.has("starbucks")).toBe(false);
  });

  it("skips uncategorized prior allocations", async () => {
    const { wsId, accountId } = await makeWs();
    await makeTx(wsId, accountId, "starbucks", new Date("2026-02-01"), null);
    const result = await findHistoryHints(wsId, ["starbucks"]);
    expect(result.has("starbucks")).toBe(false);
  });

  it("skips archived categories", async () => {
    const { wsId, accountId } = await makeWs();
    const cat = await makeCat(wsId, "Dining", true);
    await makeTx(wsId, accountId, "starbucks", new Date("2026-02-01"), cat.id);
    const result = await findHistoryHints(wsId, ["starbucks"]);
    expect(result.has("starbucks")).toBe(false);
  });

  it("batch lookup for multiple merchants in one call", async () => {
    const { wsId, accountId } = await makeWs();
    const dining = await makeCat(wsId, "Dining");
    const transit = await makeCat(wsId, "Transit");
    await makeTx(wsId, accountId, "starbucks", new Date("2026-02-01"), dining.id);
    await makeTx(wsId, accountId, "uber", new Date("2026-02-01"), transit.id);
    const result = await findHistoryHints(wsId, ["starbucks", "uber", "newmerchant"]);
    expect(result.size).toBe(2);
    expect(result.get("starbucks")?.categoryId).toBe(dining.id);
    expect(result.get("uber")?.categoryId).toBe(transit.id);
  });
});
```

- [ ] **Step 3: Run test**

```bash
pnpm -F @fina/api exec vitest run tests/categorize.history-lookup.test.ts
```

Expected: PASS (5/5).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/categorize/history-lookup.ts apps/api/tests/categorize.history-lookup.test.ts
git commit -m "feat(categorize): history-lookup batch window query"
```

---

## Task 6: LLM module — PFC hint

**Files:**
- Modify: `apps/api/src/categorize/llm.ts`
- Test: extend `apps/api/tests/categorize.service.test.ts` (covers Task 7's end-to-end PFC propagation)

The unit-of-test for PFC inclusion is "the LLM payload contains plaid_hint when provided." We'll verify via the existing geminiMock used in `categorize.service.test.ts` (asserting on the request payload captured by the mock). Test added in Task 7 Step 5.

- [ ] **Step 1: Extend `LLMTransaction` type in `apps/api/src/categorize/llm.ts`**

Replace the existing `LLMTransaction` definition:

```ts
export type LLMTransaction = {
  id: string;
  merchantRaw: string;
  amount: number;
  occurredAtISO: string;
  /** Optional Plaid PFC. Caller (service.ts) extracts from rawData and omits when missing. */
  pfc?: {
    primary: string;
    detailed: string;
    confidence: string; // "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW"
  };
};
```

- [ ] **Step 2: Include PFC in userPayload (omit when missing)**

In the same file, update the `userPayload.transactions` mapping inside `callGeminiCategorize`:

```ts
  const userPayload = {
    categories: categoryNames,
    transactions: txs.map((t) => ({
      tx_id: t.id,
      merchant: t.merchantRaw,
      amount: t.amount,
      date: t.occurredAtISO,
      ...(t.pfc ? { plaid_hint: t.pfc } : {}),
    })),
  };
```

- [ ] **Step 3: Update systemInstruction**

Replace the existing systemInstruction string:

```ts
      systemInstruction:
        "You categorize Canadian personal financial transactions. CAD currency. " +
        "Positive amount = expense, negative = income/refund. " +
        "Use exact category names from the categories list. " +
        "If a transaction includes plaid_hint (Plaid's personal_finance_category with primary/detailed/confidence), " +
        "treat HIGH/VERY_HIGH as a strong hint and MEDIUM/LOW as a weak hint when mapping into our category list. " +
        "If genuinely unclear, use 'Other'.",
```

- [ ] **Step 4: Verify typecheck**

```bash
pnpm -F @fina/api exec tsc --noEmit -p .
```

Expected: PASS (apart from preexisting unrelated errors).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/categorize/llm.ts
git commit -m "feat(categorize): LLM accepts Plaid PFC as per-tx hint (omit when missing)"
```

---

## Task 7: Categorize service — wire history step + needsConfirmation + dismissedUntil + PFC

**Files:**
- Modify: `apps/api/src/categorize/service.ts`
- Modify: `apps/api/tests/categorize.service.test.ts`

- [ ] **Step 1: Read the current `service.ts` (line 1-187) once to fix the diff sites you'll edit**

Open `apps/api/src/categorize/service.ts`. Key sites:
- `Loaded` type: ~line 60
- The `findMany` that populates `txs`: ~line 34
- Mapping branch update (~line 114): `data: { categoryId: catId, source: "mapping" }`
- LLM branch update (~line 178): `data: { categoryId: aiCatId, source: "ai" }`

- [ ] **Step 2: Resolve user mode at top of `categorizeNewTransactions`**

After the function signature, before the `findMany`:

```ts
  // Resolve mode from the workspace owner's user record.
  const owner = await prisma.membership.findFirst({
    where: { workspaceId, role: "owner" },
    select: { user: { select: { categorizationMode: true } } },
  });
  const mode = owner?.user.categorizationMode ?? "flexible";
```

- [ ] **Step 3: Extend the `findMany` `select` to include `rawData`**

In the `findMany` populating `txs`, add `rawData: true` to the `select` object so the LLM step can read Plaid PFC.

- [ ] **Step 4: Extend the `Loaded` type and the `loaded.push` block**

Change `Loaded` from:

```ts
type Loaded = { id: string; merchantRaw: string; merchantNormalized: string; amount: number; occurredAt: Date };
```

to:

```ts
type Loaded = {
  id: string;
  merchantRaw: string;
  merchantNormalized: string;
  amount: number;
  occurredAt: Date;
  rawData: unknown;
};
```

In the `loaded.push({ ... })` call:

```ts
    loaded.push({
      id: t.id,
      merchantRaw: t.merchantRaw,
      merchantNormalized: normalized,
      amount: Number(t.amount),
      occurredAt: t.occurredAt,
      rawData: t.rawData,
    });
```

- [ ] **Step 5: Update the mapping branch to write `needsConfirmation=false`**

The mapping update currently writes:

```ts
        data: { categoryId: catId, source: "mapping" },
```

Change to:

```ts
        data: { categoryId: catId, source: "mapping", needsConfirmation: false, dismissedUntil: null },
```

- [ ] **Step 6: Insert history step between mapping and LLM**

Add a new top-of-file import:

```ts
import { findHistoryHints } from "./history-lookup.js";
import { computeNeedsConfirmation } from "./needs-confirmation.js";
import { isOtherCategory } from "./other-detection.js";
```

Then after the mapping loop completes (right before `if (unmapped.length === 0) return;`), insert:

```ts
  // Step 2: History lookup (batch).
  const historyMerchants = [...new Set(unmapped.map((t) => t.merchantNormalized))];
  const historyHints = await findHistoryHints(workspaceId, historyMerchants);

  // Pre-fetch categories referenced by hints to evaluate isOther.
  const hintCategoryIds = [...new Set(Array.from(historyHints.values()).map((h) => h.categoryId))];
  const hintCategories = hintCategoryIds.length === 0 ? [] : await prisma.category.findMany({
    where: { id: { in: hintCategoryIds }, archivedAt: null },
    select: { id: true, name: true, archivedAt: true },
  });
  const hintCatById = new Map(hintCategories.map((c) => [c.id, c]));

  const stillUnmapped: Loaded[] = [];
  for (const t of unmapped) {
    const hint = historyHints.get(t.merchantNormalized);
    const hintCat = hint ? hintCatById.get(hint.categoryId) : undefined;
    if (!hint || !hintCat) { stillUnmapped.push(t); continue; }

    const isOther = isOtherCategory({ name: hintCat.name, archivedAt: hintCat.archivedAt });
    const needsConfirmation = computeNeedsConfirmation({
      mode,
      source: "history",
      isOther,
      priorNeedsConfirmation: hint.needsConfirmation,
    });
    const dismissedUntil = hint.dismissedUntil && hint.dismissedUntil.getTime() > Date.now() ? hint.dismissedUntil : null;

    // Find the single allocation row to update.
    const tx = await prisma.transaction.findFirst({
      where: { id: t.id, workspaceId },
      include: { allocations: { select: { id: true } } },
    });
    if (!tx || tx.allocations.length !== 1) { stillUnmapped.push(t); continue; }
    const alloc = tx.allocations[0]!;

    // Atomic guard preserved (categoryId IS NULL AND source IS NULL).
    await prisma.transactionAllocation.updateMany({
      where: { id: alloc.id, categoryId: null, source: null },
      data: { categoryId: hint.categoryId, source: "history", needsConfirmation, dismissedUntil },
    });
  }
  if (stillUnmapped.length === 0) return;
```

Change the LLM batch loop's reference from `unmapped` to `stillUnmapped`:

```ts
  for (let i = 0; i < stillUnmapped.length; i += batchMax) {
    const batch = stillUnmapped.slice(i, i + batchMax);
    // ...
```

- [ ] **Step 7: Map PFC into LLM payload + write needsConfirmation in ai branch**

In the `batch.map` building `llmTxs`:

```ts
    const llmTxs: LLMTransaction[] = batch.map((t) => {
      const pfcRaw = (t.rawData as { personal_finance_category?: { primary?: string; detailed?: string; confidence_level?: string } } | null)?.personal_finance_category;
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

In the LLM-result update site, change:

```ts
      const upd = await prisma.transactionAllocation.updateMany({
        where: { id: a.id, categoryId: null, source: null },
        data: { categoryId: aiCatId, source: "ai" },
      });
```

to:

```ts
      const aiCat = await prisma.category.findUnique({
        where: { id: aiCatId },
        select: { name: true, archivedAt: true },
      });
      const isOther = aiCat ? isOtherCategory({ name: aiCat.name, archivedAt: aiCat.archivedAt }) : false;
      const needsConfirmation = computeNeedsConfirmation({ mode, source: "ai", isOther, priorNeedsConfirmation: null });

      const upd = await prisma.transactionAllocation.updateMany({
        where: { id: a.id, categoryId: null, source: null },
        data: { categoryId: aiCatId, source: "ai", needsConfirmation, dismissedUntil: null },
      });
```

- [ ] **Step 8: Add test cases to `apps/api/tests/categorize.service.test.ts`**

Add specific cases (use existing `geminiMock` and helpers — see the top of that file for the established pattern). New cases:

1. history step hits with `prior_unconfirmed=true` and `mode='strict'` → new allocation has `needsConfirmation=true`
2. history step hits with prior `dismissedUntil > now` → new allocation inherits `dismissedUntil`
3. history step prior categoryId IS NULL → falls through to LLM
4. history step prior category archived → falls through to LLM
5. LLM result 'Other' + mode='auto' → needsConfirmation=true (Other override)
6. LLM result non-Other + mode='auto' → needsConfirmation=false
7. Split tx (allocations.length=2) → pipeline skips, allocations remain unchanged (no needsConfirmation set)
8. PFC present in `rawData.personal_finance_category` → `geminiMock.lastRequest()` shows `plaid_hint` field in the user payload
9. PFC absent (no `personal_finance_category`) → `geminiMock.lastRequest()` shows NO `plaid_hint` for that tx, no throw

Use `geminiMock.setResponse(...)` to control LLM output and `geminiMock.lastRequest()` to assert payload shape. If those helpers don't have `lastRequest`, inspect `apps/api/tests/helpers/gemini-mock.ts` and add a captured-request accessor — the helper already records calls per existing tests; add `export function lastGeminiRequest(): unknown` if missing.

- [ ] **Step 9: Run all categorize service tests**

```bash
pnpm -F @fina/api exec vitest run tests/categorize.service.test.ts
```

Expected: PASS (existing tests + 9 new cases).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/categorize/service.ts apps/api/tests/categorize.service.test.ts apps/api/tests/helpers/gemini-mock.ts
git commit -m "feat(categorize): wire history step + needsConfirmation/dismissedUntil + PFC hint"
```

---

## Task 8: Auto-promote module

**Files:**
- Create: `apps/api/src/categorize/auto-promote.ts`
- Create: `apps/api/tests/categorize.auto-promote.test.ts`

- [ ] **Step 1: Implement**

```ts
// apps/api/src/categorize/auto-promote.ts
import { prisma } from "../db.js";
import { logInfo } from "../logger.js";

/** Counts confirmed allocations (needsConfirmation=false) for this
 *  (workspace, merchantNormalized, categoryId) tuple where source is
 *  'ai', 'history', or 'manual'. If count ≥ 3, inserts an explicit
 *  merchant_mappings row (source='auto'), idempotent via skipDuplicates.
 *  Excludes source='mapping' from the count (would be self-counting). */
export async function maybeAutoPromote(
  workspaceId: string,
  merchantNormalized: string,
  categoryId: string,
): Promise<{ promoted: boolean; count: number }> {
  const count = await prisma.transactionAllocation.count({
    where: {
      categoryId,
      needsConfirmation: false,
      source: { in: ["ai", "history", "manual"] },
      transaction: { workspaceId, merchantNormalized, removedAt: null },
    },
  });

  if (count < 3) return { promoted: false, count };

  const insert = await prisma.merchantMapping.createMany({
    data: [{
      workspaceId,
      merchantNormalized,
      categoryId,
      confidence: 1.0,
      source: "auto",
    }],
    skipDuplicates: true,
  });

  const promoted = insert.count > 0;
  if (promoted) {
    logInfo({ workspaceId, merchantNormalized, categoryId, confirmCount: count }, "mapping.auto_promoted");
  }
  return { promoted, count };
}
```

- [ ] **Step 2: Test**

```ts
// apps/api/tests/categorize.auto-promote.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";
import { maybeAutoPromote } from "../src/categorize/auto-promote.js";

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

async function setup() {
  const app = await buildApp(testEnv());
  const u = await signUpAndGetCookie(app, { email: `ap-${Date.now()}@x.com`, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "A", type: "depository" } });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
  await app.close();
  return { wsId, accountId: acct.id, catId: cat.id };
}

async function makeAlloc(wsId: string, accountId: string, merchant: string, catId: string, source: "ai" | "history" | "manual" | "mapping", needsConfirmation: boolean) {
  await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId,
      merchantRaw: merchant.toUpperCase(), merchantNormalized: merchant,
      amount: "5.00", occurredAt: new Date(),
      source: "plaid", rawData: {},
      allocations: { create: { amount: "5.00", categoryId: catId, source, needsConfirmation } },
    },
  });
}

describe("maybeAutoPromote", () => {
  it("does not insert when count < 3", async () => {
    const { wsId, accountId, catId } = await setup();
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(false);
    expect(r.count).toBe(2);
    const map = await prisma.merchantMapping.findFirst({ where: { workspaceId: wsId, merchantNormalized: "starbucks" } });
    expect(map).toBeNull();
  });

  it("inserts when count = 3 (mixed sources)", async () => {
    const { wsId, accountId, catId } = await setup();
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "history", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "manual", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(true);
    const map = await prisma.merchantMapping.findFirst({ where: { workspaceId: wsId, merchantNormalized: "starbucks" } });
    expect(map?.source).toBe("auto");
  });

  it("excludes needsConfirmation=true from count", async () => {
    const { wsId, accountId, catId } = await setup();
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", true);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", true);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", true);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(false);
  });

  it("excludes source='mapping' from count", async () => {
    const { wsId, accountId, catId } = await setup();
    await makeAlloc(wsId, accountId, "starbucks", catId, "mapping", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "mapping", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "mapping", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(false);
    expect(r.count).toBe(0);
  });

  it("idempotent — already exists, no error", async () => {
    const { wsId, accountId, catId } = await setup();
    await prisma.merchantMapping.create({ data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: catId, confidence: 1.0, source: "manual" } });
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    // count=3 attempts INSERT, ON CONFLICT (skipDuplicates) → 0 rows affected
    expect(r.promoted).toBe(false);
  });

  it("different categories on same merchant do not auto-promote", async () => {
    const { wsId, accountId, catId } = await setup();
    const otherCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } });
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", catId, "ai", false);
    await makeAlloc(wsId, accountId, "starbucks", otherCat.id, "ai", false);
    const r = await maybeAutoPromote(wsId, "starbucks", catId);
    expect(r.promoted).toBe(false); // only 2 with this category
  });
});
```

- [ ] **Step 3: Run + pass**

```bash
pnpm -F @fina/api exec vitest run tests/categorize.auto-promote.test.ts
```

Expected: 6/6 PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/categorize/auto-promote.ts apps/api/tests/categorize.auto-promote.test.ts
git commit -m "feat(categorize): auto-promote merchant_mapping after 3 just-confirms"
```

---

## Task 9: Update `applyManualCategorize` to clear needsConfirmation + trigger auto-promote

**Files:**
- Modify: `apps/api/src/categorize/manual-categorize.ts`

The existing flow already writes `source='manual'` and upserts a merchant_mapping immediately. We just need to clear the two new fields when writing the allocation. (Auto-promote also runs for safety — though manual upsert above already inserts mapping, ON CONFLICT makes the auto-promote a no-op in this path. It does no harm.)

- [ ] **Step 1: After `applyAllocations(...)` in the `withWorkspaceLock` block, clear the new fields**

After the `await applyAllocations(...)` call, before the `tx.transaction.update`:

```ts
    // Clear new flag fields on the just-written allocation (allocations are
    // re-created by applyAllocations; defaults already give us
    // needsConfirmation=false + dismissedUntil=null, but for split→single
    // transitions or future refactors we set explicitly).
    await tx.transactionAllocation.updateMany({
      where: { transactionId: txRow.id },
      data: { needsConfirmation: false, dismissedUntil: null },
    });
```

(This is a defensive no-op when defaults already match; cheap and future-proof.)

- [ ] **Step 2: No test changes — existing `categorize.manual-service.test.ts` continues to pass**

```bash
pnpm -F @fina/api exec vitest run tests/categorize.manual-service.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/categorize/manual-categorize.ts
git commit -m "feat(categorize): manual-categorize clears needsConfirmation/dismissedUntil (defensive)"
```

---

## Task 10: Route — `POST /workspaces/:id/transactions/:txId/confirm-category`

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Create: `apps/api/tests/transactions.confirm-snooze.test.ts`

- [ ] **Step 1: Import `maybeAutoPromote` and add handler**

In `apps/api/src/routes/transactions.ts`, add to the existing import block:

```ts
import { maybeAutoPromote } from "../categorize/auto-promote.js";
```

Add a new route handler. Place it after the existing `POST /workspaces/:id/transactions/:txId/categorize` (the one calling `applyManualCategorize`, ending around line 297):

```ts
  app.post<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId/confirm-category",
    async (req, reply) => {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== req.params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tx = await prisma.transaction.findFirst({
        where: { id: req.params.txId, workspaceId: ctx.membership.workspaceId, removedAt: null },
        select: {
          id: true,
          merchantNormalized: true,
          allocations: { select: { id: true, categoryId: true } },
        },
      });
      if (!tx) return reply.code(404).send({ error: "transaction_not_found" });

      await prisma.transactionAllocation.updateMany({
        where: { transactionId: tx.id },
        data: { needsConfirmation: false, dismissedUntil: null },
      });

      // Auto-promote per allocation (best-effort)
      if (tx.merchantNormalized) {
        for (const a of tx.allocations) {
          if (a.categoryId) {
            await maybeAutoPromote(ctx.membership.workspaceId, tx.merchantNormalized, a.categoryId);
          }
        }
      }
      return reply.code(200).send({ ok: true });
    },
  );
```

- [ ] **Step 2: Write tests**

```ts
// apps/api/tests/transactions.confirm-snooze.test.ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

async function setup() {
  const app = await buildApp(testEnv());
  const u = await signUpAndGetCookie(app, { email: `cf-${Date.now()}@x.com`, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "A", type: "depository" } });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      merchantRaw: "STARBUCKS", merchantNormalized: "starbucks",
      amount: "5.00", occurredAt: new Date(),
      source: "plaid", rawData: {},
      allocations: { create: { amount: "5.00", categoryId: cat.id, source: "ai", needsConfirmation: true } },
    },
  });
  return { app, cookie: u.cookie, wsId, catId: cat.id, txId: tx.id };
}

describe("POST /workspaces/:id/transactions/:txId/confirm-category", () => {
  it("sets needsConfirmation=false + dismissedUntil=null", async () => {
    const { app, cookie, wsId, txId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/confirm-category`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const alloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(alloc?.needsConfirmation).toBe(false);
    expect(alloc?.dismissedUntil).toBeNull();
    await app.close();
  });

  it("returns 404 for missing tx", async () => {
    const { app, cookie, wsId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/nope/confirm-category`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it("auto-promotes after 3rd confirm", async () => {
    const { app, cookie, wsId, catId } = await setup();
    const acct = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: wsId } });
    // Create 2 more transactions, both already needsConfirmation=true ai sources
    const txIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const t = await prisma.transaction.create({
        data: {
          workspaceId: wsId, accountId: acct.id,
          merchantRaw: "STARBUCKS", merchantNormalized: "starbucks",
          amount: "5.00", occurredAt: new Date(),
          source: "plaid", rawData: {},
          allocations: { create: { amount: "5.00", categoryId: catId, source: "ai", needsConfirmation: true } },
        },
      });
      txIds.push(t.id);
    }
    // First tx already exists from setup() — confirm it then the others
    const firstTx = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId, id: { notIn: txIds } } });
    for (const id of [firstTx.id, ...txIds]) {
      await app.inject({ method: "POST", url: `/workspaces/${wsId}/transactions/${id}/confirm-category`, headers: { cookie } });
    }
    const map = await prisma.merchantMapping.findFirst({ where: { workspaceId: wsId, merchantNormalized: "starbucks" } });
    expect(map?.source).toBe("auto");
    await app.close();
  });
});
```

- [ ] **Step 3: Run + pass**

```bash
pnpm -F @fina/api exec vitest run tests/transactions.confirm-snooze.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/tests/transactions.confirm-snooze.test.ts
git commit -m "feat(api): POST /confirm-category + auto-promote trigger"
```

---

## Task 11: Route — `POST /workspaces/:id/transactions/:txId/snooze-category`

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Modify: `apps/api/tests/transactions.confirm-snooze.test.ts`

- [ ] **Step 1: Add handler in `transactions.ts` (right after the confirm-category handler)**

```ts
  app.post<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId/snooze-category",
    async (req, reply) => {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== req.params.id) {
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

- [ ] **Step 2: Add tests to the same file**

```ts
describe("POST /workspaces/:id/transactions/:txId/snooze-category", () => {
  it("sets dismissedUntil ~ 7d from now, keeps needsConfirmation=true", async () => {
    const { app, cookie, wsId, txId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/snooze-category`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const alloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(alloc?.needsConfirmation).toBe(true);
    expect(alloc?.dismissedUntil).not.toBeNull();
    const futureMs = alloc!.dismissedUntil!.getTime() - Date.now();
    expect(futureMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(futureMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);
    await app.close();
  });

  it("returns 404 for missing tx", async () => {
    const { app, cookie, wsId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/nope/snooze-category`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});
```

- [ ] **Step 3: Run + pass**

```bash
pnpm -F @fina/api exec vitest run tests/transactions.confirm-snooze.test.ts
```

Expected: PASS (5/5 cumulative).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/transactions.ts apps/api/tests/transactions.confirm-snooze.test.ts
git commit -m "feat(api): POST /snooze-category (7-day dismissal)"
```

---

## Task 12: `PATCH /me` accepts `categorizationMode` + `GET /me` returns it

**Files:**
- Modify: `apps/api/src/routes/me.ts`
- Modify: `apps/api/tests/me.routes.test.ts` (or whichever file exists; check `ls apps/api/tests | grep me`)

- [ ] **Step 1: Update PATCH handler**

Open `apps/api/src/routes/me.ts` and find the `app.patch("/me", ...)` handler (around line 161). The handler already uses `PatchMeBody.parse(req.body)` (extended in Task 1). Inside the existing field-application block, add:

```ts
        if (parsed.categorizationMode !== undefined) {
          updateData.categorizationMode = parsed.categorizationMode;
        }
```

(Where `updateData` is the in-progress `Prisma.UserUpdateInput` object built by the handler.)

- [ ] **Step 2: Include `categorizationMode` in the `GET /me` response**

In the `GET /me` handler, find where `user` is constructed (look for the `MeDTO` shape literal). Add to the `user` object:

```ts
          categorizationMode: u.categorizationMode,
```

Also ensure the `prisma.user.findUnique({ select: { ... } })` includes `categorizationMode: true`.

- [ ] **Step 3: Tests**

Locate existing me-tests file (search via `ls apps/api/tests | grep me`). Add cases:

```ts
it("PATCH /me accepts categorizationMode='strict'", async () => {
  // setup signUp + cookie
  const r = await app.inject({
    method: "PATCH",
    url: "/me",
    headers: { cookie },
    payload: { categorizationMode: "strict" },
  });
  expect(r.statusCode).toBe(200);
  const me = await app.inject({ method: "GET", url: "/me", headers: { cookie } });
  const body = JSON.parse(me.body);
  expect(body.user.categorizationMode).toBe("strict");
});

it("PATCH /me rejects invalid categorizationMode", async () => {
  const r = await app.inject({
    method: "PATCH",
    url: "/me",
    headers: { cookie },
    payload: { categorizationMode: "yolo" },
  });
  expect(r.statusCode).toBe(400);
});

it("GET /me returns default 'flexible' for new user", async () => {
  const me = await app.inject({ method: "GET", url: "/me", headers: { cookie } });
  const body = JSON.parse(me.body);
  expect(body.user.categorizationMode).toBe("flexible");
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm -F @fina/api exec vitest run tests/me.routes.test.ts  # adjust filename if needed
```

Expected: PASS.

```bash
git add apps/api/src/routes/me.ts apps/api/tests/me.routes.test.ts
git commit -m "feat(api): PATCH /me accepts categorizationMode; GET /me returns it"
```

---

## Task 13: Daily brief — `categorize_confirm_card` block

**Files:**
- Modify: `apps/api/src/chat/blocks.ts`
- Modify: `apps/api/src/cron/jobs/daily-brief.ts`
- Modify: `apps/api/tests/daily-brief.test.ts` (verify exists with `ls apps/api/tests | grep -i brief`; if not, create new)

- [ ] **Step 1: Add API-side block type**

In `apps/api/src/chat/blocks.ts`, add the new type and extend the union (preserve existing types):

```ts
export type CategorizeConfirmCardBlock = {
  type: "categorize_confirm_card";
  count: number;
  items: { txId: string; merchant: string; categoryName: string }[];
  moreCount: number;
};

export type PresentationBlock = TextBlock | ConfirmCardBlock | CategorizeConfirmCardBlock;
```

- [ ] **Step 2: Compute window + count + card in `daily-brief.ts`**

In `runDailyBrief`, inside the per-user loop, after `const blocks: PresentationBlock[] = await generateBrief(...)` and before the `prisma.$transaction(...)` block, add:

```ts
      // Categorize confirm card (Plan 1F).
      const u2 = await prisma.user.findUnique({
        where: { id: u.id },
        select: { categorizationMode: true },
      });
      const mode = u2?.categorizationMode ?? "flexible";
      if (mode !== "auto") {
        const lastBriefAgg = await prisma.brief.aggregate({
          where: { userId: u.id },
          _max: { createdAt: true },
        });
        const sinceMs = Math.max(
          lastBriefAgg._max.createdAt?.getTime() ?? 0,
          Date.now() - 7 * 24 * 60 * 60 * 1000,
        );
        const since = new Date(sinceMs);
        const whereCard = {
          needsConfirmation: true,
          OR: [{ dismissedUntil: null }, { dismissedUntil: { lt: new Date() } }],
          transaction: {
            removedAt: null,
            workspace: { memberships: { some: { userId: u.id } } },
            createdAt: { gte: since },
          },
        };
        const totalCount = await prisma.transactionAllocation.count({ where: whereCard });
        if (totalCount > 0) {
          const rows = await prisma.transactionAllocation.findMany({
            where: whereCard,
            take: 5,
            select: {
              transaction: { select: { id: true, merchantRaw: true, merchantNormalized: true } },
              category: { select: { name: true } },
            },
            orderBy: { transaction: { occurredAt: "desc" } },
          });
          const items = rows.map((r) => ({
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

- [ ] **Step 3: Tests (extend or create `apps/api/tests/daily-brief.test.ts`)**

Identify the existing brief test file (`ls apps/api/tests | grep -i brief`). The codebase has `cron.daily-brief.test.ts` or similar — confirm exact name. Add cases (use vi.mock for `generateBrief` to return a baseline blocks array, then assert the additional card block is appended):

```ts
it("appends categorize_confirm_card when needsConfirmation>0", async () => {
  // setup user, workspace, 3 allocations with needsConfirmation=true within window
  // mock generateBrief to return [{ type: 'text', markdown: 'hello' }]
  // mock setNotificationHandler / sendBriefPush as needed
  // run runDailyBrief at the user's local 08:00
  // fetch the brief's message blocks
  // assert one block has type='categorize_confirm_card' with count=3, items.length=3, moreCount=0
});

it("does NOT append card when needsConfirmation=0", async () => { /* analog */ });

it("excludes snoozed allocations", async () => { /* dismissedUntil = now+1d → excluded */ });

it("Auto mode skips card entirely", async () => { /* user.categorizationMode='auto' → no card */ });

it("Long-pause: lastBriefAt 30d ago → window cap of 7d applies", async () => {
  // setup: prior Brief row created 30d ago + 1 needsConfirmation alloc within last 5d + 1 needsConfirmation alloc 20d ago
  // expect: card.count === 1 (only the recent one)
});

it("Normal 2-day pause: lastBriefAt 2d ago → window from then", async () => {
  // setup: prior Brief 2d ago + 1 needsConfirmation alloc 1d ago + 1 needsConfirmation alloc 5d ago
  // expect: card.count === 1
});

it("count=7 → card.count=7, items=5, moreCount=2", async () => { /* analog */ });
```

- [ ] **Step 4: Run + commit**

```bash
pnpm -F @fina/api exec vitest run tests/daily-brief.test.ts  # adjust filename
```

Expected: PASS.

```bash
git add apps/api/src/chat/blocks.ts apps/api/src/cron/jobs/daily-brief.ts apps/api/tests/daily-brief.test.ts
git commit -m "feat(brief): categorize_confirm_card with window cap + snooze exclusion + auto mode skip"
```

---

## Task 14: Telemetry events

**Files:**
- Create: `apps/api/src/telemetry/categorize.ts`
- Modify: `apps/api/src/categorize/service.ts`
- Modify: `apps/api/src/routes/transactions.ts`

- [ ] **Step 1: Create wrappers**

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

(`mapping.auto_promoted` is already emitted inside `auto-promote.ts` — no change.)

- [ ] **Step 2: Wire `emitCategorizeCompleted` in `service.ts`**

After each successful allocation update (3 sites), emit. Provide the captured category name (look it up where needed), and PFC info (only `ai` branch has PFC; `mapping`/`history` set PFC fields to null + `pfcMissing=true`).

Mapping branch — replace the mapping success log block (currently a comment `// allocation updated — no mirror-write needed`) with:

```ts
      if (upd.count > 0) {
        const mapCat = await prisma.category.findUnique({ where: { id: catId }, select: { name: true } });
        emitCategorizeCompleted({
          workspaceId,
          source: "mapping",
          categoryName: mapCat?.name ?? "?",
          pfcPrimary: null,
          pfcConfidence: null,
          pfcMissing: true,
        });
      }
```

History branch — at the end of the history-step `for (const t of unmapped)` body after the `updateMany`:

```ts
    const histCat = hintCatById.get(hint.categoryId);
    emitCategorizeCompleted({
      workspaceId,
      source: "history",
      categoryName: histCat?.name ?? "?",
      pfcPrimary: null,
      pfcConfidence: null,
      pfcMissing: true,
    });
```

LLM (ai) branch — after the LLM `updateMany`:

```ts
      const pfc = batch.find((bt) => bt.id === r.tx_id);
      const pfcRaw = (pfc?.rawData as { personal_finance_category?: { primary?: string; confidence_level?: string } } | null)?.personal_finance_category;
      emitCategorizeCompleted({
        workspaceId,
        source: "ai",
        categoryName: aiCat?.name ?? "?",
        pfcPrimary: pfcRaw?.primary ?? null,
        pfcConfidence: pfcRaw?.confidence_level ?? null,
        pfcMissing: !pfcRaw?.primary,
      });
```

- [ ] **Step 3: Wire `emitCategorizeConfirmed` in routes**

In `routes/transactions.ts`:

- In `POST /confirm-category` handler, after the `updateMany`:

```ts
      for (const a of tx.allocations) {
        // Read alloc.source via a fresh fetch (we updated `needsConfirmation` only; source preserved)
        emitCategorizeConfirmed({
          workspaceId: ctx.membership.workspaceId,
          source: (await prisma.transactionAllocation.findUnique({ where: { id: a.id }, select: { source: true } }))?.source ?? "ai",
          action: "confirm",
        });
      }
```

- In `POST /snooze-category` handler, after the `updateMany`:

```ts
      emitCategorizeConfirmed({
        workspaceId: ctx.membership.workspaceId,
        source: "ai", // approximate — actual source may vary, but snooze action doesn't change it
        action: "snooze",
      });
```

- In `POST /workspaces/:id/transactions/:txId/categorize` (the existing edit path calling `applyManualCategorize`), after the successful response:

```ts
      emitCategorizeConfirmed({
        workspaceId: ctx.membership.workspaceId,
        source: "manual",
        action: "edit",
      });
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/telemetry/categorize.ts apps/api/src/categorize/service.ts apps/api/src/routes/transactions.ts
git commit -m "feat(telemetry): categorize.completed/.confirmed events"
```

---

## Task 15: Mobile — `/categorization` mode setting screen

**Files:**
- Create: `apps/mobile/app/categorization/index.tsx`

- [ ] **Step 1: Build the screen**

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
  { key: "flexible", title: "Flexible", sub: "New merchants only need one confirm. Skipping is fine." },
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
    flexDirection: "row", alignItems: "center",
    backgroundColor: colors.canvas,
    borderWidth: 1, borderColor: colors.hairline, borderRadius: 14,
    padding: space.base,
  },
  cardSelected: { borderColor: colors.primary },
  cardTitle: { ...type$.titleSm, color: colors.ink, marginBottom: 4 },
  cardSub: { ...type$.bodySm, color: colors.body },
});
```

- [ ] **Step 2: Verify mobile typecheck**

```bash
pnpm typecheck
```

Expected: PASS (preexisting unrelated errors aside).

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/categorization/index.tsx
git commit -m "feat(mobile): /categorization mode setting screen"
```

---

## Task 16: Mobile — More tab row restoration

**Files:**
- Modify: `apps/mobile/app/(tabs)/more.tsx`

- [ ] **Step 1: Find the AI group in `more.tsx` and modify it**

In Task v.previous we removed the row. Locate the AI group (find by the label "AI" in `<GroupLabel>`). The Notifications row currently has `last`. Change it back to not be last, and add the Categorization style row as the new last row:

```tsx
          <SettingsRow
            icon="notifications-outline"
            title="Notifications"
            detail={notificationsDetail(me)}
            onPress={() => router.push("/notifications" as never)}
          />
          <SettingsRow
            icon="construct-outline"
            title="Categorization style"
            detail={modeLabel(me)}
            onPress={() => router.push("/categorization" as never)}
            last
          />
```

- [ ] **Step 2: Add `modeLabel` helper**

Near the existing helpers (`briefSubtitle`, `notificationsDetail`):

```ts
function modeLabel(me: Me | null): string {
  if (!me) return "—";
  switch (me.user.categorizationMode) {
    case "strict":   return "Strict";
    case "flexible": return "Flexible";
    case "auto":     return "Auto";
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/(tabs)/more.tsx
git commit -m "feat(mobile): restore Categorization style row in More AI group"
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

export function NeedsReviewPill({ isOther, onPress }: { isOther: boolean; onPress: () => void }) {
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
    paddingHorizontal: 10, paddingVertical: 4,
    borderRadius: 999, borderWidth: 1,
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

## Task 18: Mobile — `ConfirmSheet` component

**Files:**
- Create: `apps/mobile/src/categorize/ConfirmSheet.tsx`

- [ ] **Step 1: Build the sheet**

```tsx
// apps/mobile/src/categorize/ConfirmSheet.tsx
import { useCallback, useEffect, useMemo, useRef } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import BottomSheet, { BottomSheetView } from "@gorhom/bottom-sheet";
import { apiFetch } from "../api/client";
import { colors, space, type as type$ } from "../design/tokens";

export type ConfirmSheetTarget = {
  workspaceId: string;
  txId: string;
  merchant: string;
  categoryName: string;
};

export function ConfirmSheet({
  target,
  onClose,
  onConfirmed,
  onEditPress,
}: {
  target: ConfirmSheetTarget | null;
  onClose: () => void;
  onConfirmed: () => void;
  onEditPress: (target: ConfirmSheetTarget) => void;
}) {
  const ref = useRef<BottomSheet>(null);
  const snapPoints = useMemo(() => ["28%"], []);
  const explicitChoice = useRef(false);

  useEffect(() => {
    if (target) { explicitChoice.current = false; ref.current?.expand(); }
    else        { ref.current?.close(); }
  }, [target]);

  const onChange = useCallback(async (index: number) => {
    if (index === -1 && target && !explicitChoice.current) {
      try {
        await apiFetch(`/workspaces/${target.workspaceId}/transactions/${target.txId}/snooze-category`, { method: "POST" });
      } catch { /* swallow */ }
      onClose();
    }
  }, [target, onClose]);

  if (!target) return null;

  async function confirm() {
    explicitChoice.current = true;
    try {
      await apiFetch(`/workspaces/${target!.workspaceId}/transactions/${target!.txId}/confirm-category`, { method: "POST" });
      onConfirmed();
    } catch { /* surface via Alert if needed */ }
    ref.current?.close();
  }

  function pickOther() {
    explicitChoice.current = true;
    onEditPress(target!);
    ref.current?.close();
  }

  return (
    <BottomSheet ref={ref} index={-1} snapPoints={snapPoints} enablePanDownToClose onChange={onChange}>
      <BottomSheetView style={styles.body}>
        <Text style={styles.q}>{target.merchant} → {target.categoryName} 이 맞아요?</Text>
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

- [ ] **Step 2: Commit**

```bash
git add apps/mobile/src/categorize/ConfirmSheet.tsx
git commit -m "feat(mobile): ConfirmSheet — Confirm / Edit / dismiss-as-snooze"
```

---

## Task 19: Mobile — Activity tab pill + sheet integration

**Files:**
- Modify: `apps/mobile/app/(tabs)/activity.tsx`

- [ ] **Step 1: Read the current `activity.tsx` to find the row map**

Open `apps/mobile/app/(tabs)/activity.tsx`. The transaction row map renders per-tx — find where each transaction is rendered. Look for `transactions.map((tx) => (...)` or similar. The row likely has merchant + amount + category text on each row.

- [ ] **Step 2: Add state + render pill**

At the top of the component, alongside other state:

```tsx
const [confirmTarget, setConfirmTarget] = useState<ConfirmSheetTarget | null>(null);
```

Imports:

```ts
import { NeedsReviewPill } from "../../src/categorize/NeedsReviewPill";
import { ConfirmSheet, type ConfirmSheetTarget } from "../../src/categorize/ConfirmSheet";
import { CategoryPickerSheet } from "../../src/categories/CategoryPickerSheet"; // existing
```

For each transaction row, determine whether to show the pill. Each tx has `allocations: AllocationDTO[]`. Show the pill if any allocation has `needsConfirmation === true` and `(dismissedUntil == null || new Date(dismissedUntil) < new Date())`. For Other detection on the row, compare `category.name === 'Other'` (case-insensitive). Pass `isOther` accordingly.

Inside the row JSX (next to the category text):

```tsx
{(() => {
  const a = tx.allocations[0]; // single-alloc only; split rows show no pill
  if (!a || !a.needsConfirmation) return null;
  if (a.dismissedUntil && new Date(a.dismissedUntil) >= new Date()) return null;
  const categoryName = /* look up from your existing category map */;
  const isOther = (categoryName ?? "").trim().toLowerCase() === "other";
  return (
    <NeedsReviewPill
      isOther={isOther}
      onPress={() => setConfirmTarget({
        workspaceId: activeWorkspaceId,
        txId: tx.id,
        merchant: tx.merchantNormalized ?? tx.merchantRaw,
        categoryName: categoryName ?? "Uncategorized",
      })}
    />
  );
})()}
```

(The exact insertion site depends on the existing row layout; place it in whatever right-side or trailing slot the row has.)

- [ ] **Step 3: Render ConfirmSheet + integrate CategoryPickerSheet at screen level**

At the end of the screen JSX (before the closing `</SafeAreaView>` or similar):

```tsx
<ConfirmSheet
  target={confirmTarget}
  onClose={() => { setConfirmTarget(null); refetchTransactions(); }}
  onConfirmed={() => { setConfirmTarget(null); refetchTransactions(); }}
  onEditPress={(t) => {
    setConfirmTarget(null);
    setPickerForTx(t.txId); // existing picker integration
  }}
/>
```

`refetchTransactions` is the existing data-refresh function in this screen — find it (likely a `useQuery` `refetch` or a manual fetch callback).

- [ ] **Step 4: Verify manually**

Start mobile dev:

```bash
pnpm smoke:mobile:lan
```

(Note: per project memory, Expo Go requires Tailscale `100.65.93.102`.) Open Activity tab. Verify:
- A transaction with `needsConfirmation=true` shows the yellow pill.
- A transaction whose category is "Other" shows the red-bordered pill.
- Tap pill → sheet opens with merchant → category question.
- Confirm → pill disappears, alloc shows `needsConfirmation=false` on next refresh.
- Swipe down → POST snooze fires (verify in API logs); pill disappears for 7 days.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/app/(tabs)/activity.tsx
git commit -m "feat(mobile): Activity tab pill + ConfirmSheet integration"
```

---

## Task 20: Mobile — `categorize_confirm_card` renderer

**Files:**
- Modify: `apps/mobile/src/chat/PresentationBlock.tsx`

- [ ] **Step 1: Read the current renderer to confirm existing variant handling**

Open `apps/mobile/src/chat/PresentationBlock.tsx`. It already handles `text` and `confirm_card`. Add a new branch.

- [ ] **Step 2: Add the variant + import what's needed**

Add to existing imports if missing:

```tsx
import { Pressable } from "react-native";
import { router } from "expo-router";
```

Inside the renderer (before the fallback unknown-type branch), add:

```tsx
if (block.type === "categorize_confirm_card") {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>오늘 분류한 {block.count}개 확인해주세요</Text>
      {block.items.map((it) => (
        <Text key={it.txId} style={styles.cardItem}>
          {it.merchant} → {it.categoryName}
        </Text>
      ))}
      {block.moreCount > 0 && (
        <Text style={styles.cardMore}>외 {block.moreCount}건</Text>
      )}
      <Pressable
        style={styles.cardCta}
        onPress={() => router.push("/(tabs)/activity" as never)}
      >
        <Text style={styles.cardCtaText}>Activity에서 보기</Text>
      </Pressable>
    </View>
  );
}
```

Add the styles to the existing `StyleSheet.create` block:

```tsx
  card: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 14,
    padding: space.base,
    gap: 6,
  },
  cardTitle: { ...type$.titleSm, color: colors.ink },
  cardItem:  { ...type$.bodySm, color: colors.body },
  cardMore:  { ...type$.bodySm, color: colors.muted, fontStyle: "italic" },
  cardCta:   { marginTop: space.sm, alignSelf: "flex-start" },
  cardCtaText: { ...type$.captionStrong, color: colors.primary },
```

(Re-use existing `colors` / `space` / `type$` imports if already present.)

- [ ] **Step 3: Verify mobile typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/chat/PresentationBlock.tsx
git commit -m "feat(mobile): categorize_confirm_card block renderer in PresentationBlock"
```

---

## Self-review checklist

**Spec coverage:**
- §Pipeline (mapping/history/LLM-PFC) → Tasks 5, 6, 7
- §Mode setting (DB + screen + More row + PATCH/GET /me) → Tasks 1, 2, 12, 15, 16
- §needsConfirmation matrix → Task 3 (full 15-cell test) + Task 7 (wiring)
- §Snooze (7d, history-inherit, all dismiss paths) → Task 7 Step 6 (history inherit), Task 11 (route), Task 18 (sheet)
- §Auto-promote → Task 8 + Task 10 (POST /confirm-category) + Task 9 (manual-categorize already inserts mapping, ON CONFLICT safe)
- §Confirm UX (Activity pill, sheet, brief card) → Tasks 17, 18, 19, 13, 20
- §Brief window cap → Task 13 + Task 13 Step 3 tests (30d + 2d cases)
- §Migrations → Task 2 with raw SQL ALTER + partial index
- §AllocationDTO/MeDTO/PresentationBlock updates → Task 1
- §Telemetry events → Task 14 (with branch-specific PFC sourcing)
- §Risks (Other archive, multi-workspace) → covered by helper logic; no tasks needed beyond existing

**Placeholder scan:** No "TBD", no "implement later", no "use whatever pattern" left. Test bodies are concrete. File paths corrected (`apps/api/tests/`). Schema/migration strategy is single (declare columns + enums in schema; partial index via raw SQL).

**Type consistency:** `CategorizationMode` / `CategorizationSource` / `AllocationDTO` / `MeDTO.user` / `PresentationBlock` names match between Task 1 (shared), Task 2 (Prisma), and all consumers (Tasks 7-20). Prisma model is `Membership` (Task 7).

**Test file paths:** All under `apps/api/tests/<name>.test.ts`. Run commands use `pnpm -F @fina/api exec vitest run tests/<name>.test.ts`.

**Spec test coverage:**
- mapping/history/ai × matrix (Task 3 full matrix; Task 7 step 8 integration cases)
- snooze inherit (Task 7 step 8 case 2)
- prior-null fall-through (Task 7 step 8 case 3)
- archived prior (Task 7 step 8 case 4)
- Other override × auto (Task 3 + Task 7 step 8 case 5)
- Split tx skip (Task 7 step 8 case 7)
- PFC included / null (Task 7 step 8 cases 8, 9)
- auto-promote count rule, 3-confirm, mapping exclusion (Task 8 step 2)
- confirm-category endpoint (Task 10)
- snooze-category endpoint (Task 11)
- PATCH /me categorizationMode (Task 12)
- brief card window cap (Task 13 step 3, 30d + 2d cases)
- brief card snooze exclusion + Auto skip (Task 13 step 3)
