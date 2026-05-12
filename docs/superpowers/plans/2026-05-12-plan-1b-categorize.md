# Plan 1B-categorize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-categorize Plaid-synced transactions: merchant-mapping lookup first (no LLM cost), Gemini Flash Lite fallback for the rest. Manual categorize API creates mappings + back-fills siblings.

**Architecture:** Backend only. New `MerchantMapping` table + `Transaction.categorizationSource` column + 11 English category seed (with case-insensitive partial unique). `syncTransactions` returns `newTxIds`; callers wire categorize per their latency budget — exchange route fires it as a detached promise to keep the 30 s soft timeout intact, manual sync awaits. Loop-until-stable merchant normalizer. Gemini structured JSON output via `@google/genai`.

**Tech Stack:** Prisma 5 + Postgres 16 (existing), Fastify 5 + Better Auth 1.6 (existing), `@google/genai` ^1 (new), vitest 2, Plaid Node SDK 42 (foundation), react-plaid-link 4 (foundation).

---

## Spec context

This plan implements `docs/superpowers/specs/2026-05-12-plan-1b-categorize-design.md` end-to-end. Spec went through 3 rounds of codex review (0 Critical, settled at "ready to write plan"). Master spec: §15 Phase 1B categorization portion + §5 chat agent tools (consumed in Phase 1C) + §8 data model (`merchant_mappings`).

**Builds on Plan 1B-foundation (commit 242d6dd):**
- `categories`, `transactions`, `plaid_items`, `bank_accounts` tables exist.
- `transactions.merchantNormalized` (String?) and `transactions.categoryId` (String?) columns exist but are unused.
- `syncTransactions` in `apps/api/src/plaid/sync.ts` returns `SyncResult = {added, modified, removed} | {skipped, added, modified, removed}`.
- `upsertAdded` returns `void` and uses a `findFirst → update | create` pattern (codex round-2 fix from Plan 1B-foundation).
- 146 API tests passing.

---

## File Structure

| File | Op | Purpose |
|---|---|---|
| `apps/api/prisma/schema.prisma` | modify | Add `MerchantMapping` model + `MappingSource` enum; add `Transaction.categorizationSource` + `CategorizationSource` enum; **drop** `Category.@@unique([workspaceId, name])`; add back-relations on `Workspace` + `Category` |
| `apps/api/prisma/migrations/<ts>_add_categorize/migration.sql` | new | Generated + 2 raw SQL appendices: partial unique index on categories + category seed backfill |
| `apps/api/src/env.ts` | modify | `GEMINI_API_KEY` (required), `CATEGORIZE_BATCH_MAX` (optional, default 50) |
| `apps/api/.env.test` | modify | `GEMINI_API_KEY=test_gemini_key` |
| `.env.example` | modify | document GEMINI_API_KEY |
| `apps/api/package.json` | modify | add `@google/genai@^1` |
| `apps/api/src/categorize/normalize.ts` | new | `normalizeMerchant(raw)` — loop-until-stable, max 5 iters |
| `apps/api/src/categorize/seed.ts` | new | `DEFAULT_CATEGORIES` constant + `seedDefaultCategories(tx, workspaceId)` |
| `apps/api/src/workspaces/bootstrap.ts` | modify | Call `seedDefaultCategories(tx, ws.id)` inside the existing bootstrap tx |
| `apps/api/src/categorize/llm.ts` | new | `callGeminiCategorize(env, categoryNames, txs)` — `@google/genai` wrapper with structured output |
| `apps/api/src/categorize/service.ts` | new | `categorizeNewTransactions(env, workspaceId, newTxIds)` — mapping-first + LLM fallback |
| `apps/api/src/plaid/sync.ts` | modify | Augment `SyncResult` with `newTxIds: string[]`; change `upsertAdded` return type to `{kind, localId}`; collect `newTxIds` across pages + final tx |
| `apps/api/src/routes/plaid.ts` | modify | Exchange route: fire `categorizeNewTransactions(...)` as detached promise after sync result is computed |
| `apps/api/src/routes/plaid-items.ts` | modify | Manual sync route: `await categorizeNewTransactions(...)` between sync and response |
| `apps/api/src/routes/categories.ts` | new | GET/POST/PATCH categories with case-insensitive active-only uniqueness + hard caps |
| `apps/api/src/routes/transactions.ts` | modify | (1) Add `?uncategorizedOnly=true` BoolFlag filter to existing GET; (2) Add `POST /:txId/categorize` |
| `apps/api/src/server.ts` | modify | Register `categoriesRoutes` |
| `apps/api/tests/helpers/gemini-mock.ts` | new | `vi.hoisted` factory mirror of plaid-mock; scriptable queue |
| `apps/api/tests/categorize.normalize.test.ts` | new | normalizer cases |
| `apps/api/tests/categorize.service.test.ts` | new | service unit tests (Gemini mocked) |
| `apps/api/tests/categorize.routes.test.ts` | new | categories CRUD + manual categorize routes |
| `apps/api/tests/plaid.sync.test.ts` | modify | Add `newTxIds` shape tests; verify sync does NOT call categorize |
| `apps/api/tests/plaid.exchange.test.ts` | modify | Add detached-categorize test (mocked Gemini) + LLM failure handling |
| `apps/api/tests/plaid.routes.test.ts` | modify | Add manual-sync-awaits-categorize test |
| `apps/api/tests/workspaces.bootstrap.test.ts` | modify | Add "seeded 11 categories on signup" test |
| `apps/api/tests/auth.context.test.ts` + 9 others | modify | Add `GEMINI_API_KEY` to test env literals |
| `e2e/plan-1b-categorize.spec.ts` | new | Full categorize E2E: sandbox connect → auto-categorize → manual recategorize → back-fill |
| `e2e/helpers/auth.ts` | modify | (optional) helpers for category fetch if E2E needs them |
| `docs/superpowers/smoke-tests/2026-05-12-plan-1b-categorize.md` | new | smoke guide |
| `README.md` | modify | Status block |

---

## Task 1: Schema — `MerchantMapping` + `Transaction.categorizationSource` + drop categories `@@unique` + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_add_categorize/migration.sql`
- Modify: `apps/api/tests/helpers/db.ts` (no change needed — cascades cover new table)

- [ ] **Step 1: Edit `apps/api/prisma/schema.prisma`**

**1a. Add back-relations on `Workspace`** — find the `Workspace` model's relation block (alongside `plaidItems`, `bankAccounts`, `transactions`, `categories`) and add:

```prisma
  merchantMappings  MerchantMapping[]
```

**1b. Add back-relation on `Category`** — find the `Category` model and:
- Add `merchantMappings MerchantMapping[]` to the relations block
- **Remove** the line `@@unique([workspaceId, name])` (it's being replaced by a partial unique index in raw SQL)

**1c. Add `categorizationSource` field to `Transaction`** — find the `Transaction` model and add `categorizationSource CategorizationSource?` (nullable) inside the field block.

**1d. Append the new models + enums at the end of the file** (after the existing enums):

```prisma
model MerchantMapping {
  id                  String         @id @default(cuid())
  workspaceId         String
  // Lowercased, stripped of store IDs/state codes/city qualifiers.
  // E.g. "STARBUCKS #1234 TORONTO ON" → "starbucks".
  // See apps/api/src/categorize/normalize.ts for the exact rules.
  merchantNormalized  String
  categoryId          String
  // 0.00 – 1.00. Manual confirms = 1.00. Reserved for confidence-weighted
  // UI (Phase 2) — stored but not consumed in Plan 1B.
  confidence          Decimal        @default(1.00) @db.Decimal(3, 2)
  source              MappingSource
  createdAt           DateTime       @default(now())

  workspace  Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  category   Category  @relation(fields: [categoryId],  references: [id], onDelete: Cascade)

  @@unique([workspaceId, merchantNormalized])
  @@index([workspaceId])
  @@map("merchant_mappings")
}

enum MappingSource {
  manual
  ai
  auto
}

enum CategorizationSource {
  mapping
  ai
  manual
}
```

- [ ] **Step 2: Generate the migration without applying**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_categorize
```

This writes the SQL under `apps/api/prisma/migrations/<ts>_add_categorize/migration.sql` but does NOT apply. We need to append the partial unique index + seed backfill before applying.

- [ ] **Step 3: Append partial unique index + category seed backfill to `migration.sql`**

Open `apps/api/prisma/migrations/<ts>_add_categorize/migration.sql`. At the end, append:

```sql
-- Partial unique: case-insensitive name uniqueness scoped to ACTIVE categories.
-- Replaces the dropped @@unique([workspaceId, name]) from Prisma. Prisma can't
-- model partial indexes natively, so this is raw SQL.
CREATE UNIQUE INDEX "categories_one_active_name_per_workspace_ci"
  ON "categories" ("workspaceId", lower("name"))
  WHERE "archivedAt" IS NULL;

-- Seed 11 default English categories for every existing workspace.
-- Uses gen_random_uuid() for the id column — it's a core Postgres 16 function
-- 16 by default. The id column is free-form TEXT (existing rows use cuid()),
-- so mixing UUID-shaped rows is fine.
--
-- WHERE NOT EXISTS instead of ON CONFLICT because the new partial unique
-- index doesn't cover ON CONFLICT cleanly; WHERE NOT EXISTS is clearer and
-- idempotent (safe to re-run, respects users who pre-created any of these
-- names in any case before this migration).
INSERT INTO "categories" ("id", "workspaceId", "name", "createdAt")
SELECT
  gen_random_uuid()::text,
  w.id,
  c.name,
  NOW()
FROM "workspaces" w
CROSS JOIN (VALUES
  ('Groceries'),('Dining'),('Transit'),('Housing'),('Utilities'),
  ('Health'),('Shopping'),('Entertainment'),('Subscriptions'),('Income'),('Other')
) AS c(name)
WHERE NOT EXISTS (
  SELECT 1 FROM "categories"
  WHERE "workspaceId" = w.id
    AND lower("name") = lower(c.name)
    AND "archivedAt" IS NULL
);
```

- [ ] **Step 4: Apply the migration to dev + test DBs**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:migrate
```

Expected: "Your database is now in sync with your schema."

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api db:deploy
```

Expected: "All migrations have been successfully applied."

- [ ] **Step 5: Sanity-check the partial index + seed**

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c "\d categories" | grep -E 'one_active_name|name_ci'
```

Expected: row showing `categories_one_active_name_per_workspace_ci UNIQUE, btree ("workspaceId", lower(name)) WHERE archivedAt IS NULL`.

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c "SELECT name FROM categories LIMIT 15;"
```

Expected: 11 category names per existing workspace (depends on how many test workspaces exist).

- [ ] **Step 6: Run existing test suite (expect 146/146 pass — schema only, no behavior change yet)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 146 tests pass.

- [ ] **Step 7: DO NOT COMMIT.** The user reviews the full plan implementation before committing.

---

## Task 2: Env vars (`GEMINI_API_KEY`, `CATEGORIZE_BATCH_MAX`) + test literal patches

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/.env.test`
- Modify: `.env.example` (root)
- Modify: 10+ existing test files (`buildApp(env)` literals)

- [ ] **Step 1: Add fields to zod schema in `apps/api/src/env.ts`**

After the existing `ENCRYPTION_KEY` line:

```ts
  // Gemini (categorize)
  GEMINI_API_KEY: z.string(),
  // OPTIONAL — keeps test literals clean. Use `env.CATEGORIZE_BATCH_MAX ?? 50`
  // in service code. z.default() would make the inferred Env type non-optional,
  // requiring every buildApp(env) test literal to include it.
  CATEGORIZE_BATCH_MAX: z.coerce.number().int().positive().optional(),
```

- [ ] **Step 2: Add to `apps/api/.env.test`**

Append:

```
GEMINI_API_KEY=test_gemini_key
```

(`CATEGORIZE_BATCH_MAX` has a default so test env doesn't need to set it.)

- [ ] **Step 3: Update `.env.example` (root)**

Add a section before "Mobile":

```
# Gemini (categorize — Plan 1B-categorize)
# Get an API key at https://aistudio.google.com/app/apikey (free tier OK).
GEMINI_API_KEY=
```

- [ ] **Step 4: Patch existing test env literals**

Every test file that builds an `env` object for `buildApp(env)` needs `GEMINI_API_KEY: "test_gemini_key"`. Use sed:

```bash
cd /home/cwsbr/personal/fina/apps/api/tests
for f in auth.context.test.ts auth.session.test.ts health.test.ts \
         invites.routes.test.ts invites.service.test.ts me.test.ts \
         members.routes.test.ts members.service.test.ts membership.test.ts \
         workspaces.test.ts plaid.crypto.test.ts plaid.tier.test.ts \
         plaid.items.test.ts plaid.sync.test.ts plaid.exchange.test.ts \
         plaid.routes.test.ts; do
  sed -i 's|ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",|ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",\n  GEMINI_API_KEY: "test_gemini_key",|' "$f"
done
```

Verify each got the patch:

```bash
grep -L 'GEMINI_API_KEY: "test_gemini_key"' /home/cwsbr/personal/fina/apps/api/tests/*.test.ts
```

Expected: empty output (no files missing the key — except `workspaces.bootstrap.test.ts` which doesn't build an env literal).

- [ ] **Step 5: Verify**

```bash
pnpm nx run api:typecheck
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: typecheck green; 146/146 tests still pass.

- [ ] **Step 6: NO COMMIT.**

---

## Task 3: Merchant normalizer (TDD, pure function)

**Files:**
- Create: `apps/api/src/categorize/normalize.ts`
- Create: `apps/api/tests/categorize.normalize.test.ts`

- [ ] **Step 1: Write failing tests first**

Create `apps/api/tests/categorize.normalize.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeMerchant } from "../src/categorize/normalize.js";

describe("normalizeMerchant", () => {
  it("uppercase store with hash store ID + city + state → bare merchant", () => {
    expect(normalizeMerchant("STARBUCKS #1234 TORONTO ON")).toBe("starbucks");
  });

  it("strips hash store ID (no city/state)", () => {
    expect(normalizeMerchant("McDonald's #5152")).toBe("mcdonald's");
  });

  it("strips bare digits + state", () => {
    expect(normalizeMerchant("Walmart 1234 BC")).toBe("walmart");
  });

  it("strips Plaid alphanumeric store ID (q39 / r12 / s4 / t99)", () => {
    expect(normalizeMerchant("McDonalds q39")).toBe("mcdonalds");
    expect(normalizeMerchant("McDonalds r12")).toBe("mcdonalds");
  });

  it("strips trailing CA city from allowlist", () => {
    expect(normalizeMerchant("Tim Hortons Toronto")).toBe("tim hortons");
    expect(normalizeMerchant("Pho House Vancouver")).toBe("pho house");
  });

  it("strips trailing parenthesized location", () => {
    expect(normalizeMerchant("Pizza Pizza (Toronto)")).toBe("pizza pizza");
  });

  it("trims and collapses whitespace", () => {
    expect(normalizeMerchant("   Starbucks   ")).toBe("starbucks");
    expect(normalizeMerchant("Tim  Hortons")).toBe("tim hortons");
  });

  it("leaves clean input alone", () => {
    expect(normalizeMerchant("Amazon.ca")).toBe("amazon.ca");
    expect(normalizeMerchant("Loblaws")).toBe("loblaws");
  });

  it("loop terminates: max iters reached → returns last stable form", () => {
    // Construct a string that doesn't fully reduce within 5 iters — should
    // still return without throwing.
    const weird = "shop #1 toronto on vancouver bc";
    const out = normalizeMerchant(weird);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("empty input → empty output", () => {
    expect(normalizeMerchant("")).toBe("");
    expect(normalizeMerchant("   ")).toBe("");
  });
});
```

- [ ] **Step 2: Run (expect fail — module missing)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/categorize.normalize.test.ts
```

Expected: FAIL — `Failed to load url ../src/categorize/normalize.js`.

- [ ] **Step 3: Implement `apps/api/src/categorize/normalize.ts`**

```ts
/**
 * Rule-based merchant normalization, applied loop-until-stable (max 5 iters).
 * One rule's strip can expose another rule's pattern, so we re-run until the
 * string stops changing. See plan §4.3 for the worked example:
 *   "STARBUCKS #1234 TORONTO ON" → "starbucks #1234 toronto" (strip ON)
 *                                → "starbucks #1234" (strip toronto)
 *                                → "starbucks" (strip #1234)
 *                                → "starbucks" (stable)
 */

const CA_CITIES = new Set([
  "toronto", "vancouver", "montreal", "calgary", "ottawa",
  "edmonton", "mississauga", "winnipeg", "quebec", "hamilton",
]);

function applyRules(input: string): string {
  let s = input.trim().toLowerCase();

  // Rule 2: trailing parenthesized location
  s = s.replace(/\s*\([^)]+\)\s*$/, "");

  // Rule 3: trailing 2-letter state/province code
  s = s.replace(/\s+[a-z]{2}$/, "");

  // Rule 4: trailing store IDs (three patterns)
  s = s.replace(/\s+#\d+$/, "");           // "#1234"
  s = s.replace(/\s+\d+$/, "");             // bare digits
  s = s.replace(/\s+[qrst]\d+$/, "");      // Plaid-style "q39"

  // Rule 5: trailing CA city
  const cityMatch = s.match(/\s+([a-z]+)$/);
  if (cityMatch && CA_CITIES.has(cityMatch[1]!)) {
    s = s.slice(0, cityMatch.index!).trimEnd();
  }

  // Rule 6: collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

const MAX_ITERS = 5;

export function normalizeMerchant(raw: string): string {
  let prev = raw;
  let curr = applyRules(prev);
  for (let i = 1; i < MAX_ITERS && curr !== prev; i++) {
    prev = curr;
    curr = applyRules(prev);
  }
  return curr;
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/categorize.normalize.test.ts
```

Expected: 10/10 PASS.

- [ ] **Step 5: Full suite check**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 156/156 (146 prior + 10 new).

- [ ] **Step 6: NO COMMIT.**

---

## Task 4: Category seed module + bootstrap hook

**Files:**
- Create: `apps/api/src/categorize/seed.ts`
- Modify: `apps/api/src/workspaces/bootstrap.ts`
- Modify: `apps/api/tests/workspaces.bootstrap.test.ts`

- [ ] **Step 1: Read existing bootstrap.ts to understand the tx shape**

```bash
sed -n '1,80p' apps/api/src/workspaces/bootstrap.ts
```

Note where `prisma.workspace.create` happens inside `prisma.$transaction`. The seed insertion needs to be inside the same `tx` callback to share atomicity.

- [ ] **Step 2: Create `apps/api/src/categorize/seed.ts`**

```ts
import type { Prisma } from "@prisma/client";

/**
 * Default categories seeded on workspace bootstrap. English for v1; the
 * spec's §10 plans a category_translations table for localization in v2.
 *
 * `Income` is included because Plaid sends negative-amount transactions
 * (refunds, deposits) under merchant_name and we need a target for them.
 */
export const DEFAULT_CATEGORIES = [
  "Groceries",
  "Dining",
  "Transit",
  "Housing",
  "Utilities",
  "Health",
  "Shopping",
  "Entertainment",
  "Subscriptions",
  "Income",
  "Other",
] as const;

/** Insert all default categories for a workspace. Idempotent: skips any
 *  active categories already present with the same case-insensitive name. */
export async function seedDefaultCategories(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.category.createMany({
    data: DEFAULT_CATEGORIES.map((name) => ({ workspaceId, name })),
    skipDuplicates: true, // safety net; bootstrap creates a fresh workspace so collisions shouldn't happen
  });
}
```

- [ ] **Step 3: Hook into `apps/api/src/workspaces/bootstrap.ts`**

Find the line where the workspace is created inside `prisma.$transaction`. After the workspace creation (and after the owner Membership is created), add:

```ts
import { seedDefaultCategories } from "../categorize/seed.js";

// ... inside the existing $transaction callback, after workspace + membership are created:
await seedDefaultCategories(tx, ws.id);
```

The exact location depends on the existing structure — add it as the last operation inside the bootstrap tx so any failure earlier in the tx rolls everything back together.

- [ ] **Step 4: Write failing test in `apps/api/tests/workspaces.bootstrap.test.ts`**

Append a new test (don't replace existing tests — read the file first to see what's there):

```ts
  it("seeds 11 default categories on workspace bootstrap", async () => {
    const u = await prisma.user.create({
      data: { id: `bs-cat-${Date.now()}`, email: `bscat-${Date.now()}@x.com`, name: "BSCat" },
    });
    const wsId = await startTrialAndBootstrapWorkspace(u.id);
    const cats = await prisma.category.findMany({
      where: { workspaceId: wsId, archivedAt: null },
      orderBy: { name: "asc" },
      select: { name: true },
    });
    expect(cats.map((c) => c.name).sort()).toEqual([
      "Dining", "Entertainment", "Groceries", "Health", "Housing",
      "Income", "Other", "Shopping", "Subscriptions", "Transit", "Utilities",
    ]);
  });
```

(Adjust `startTrialAndBootstrapWorkspace` import + signature to match the existing test file's pattern. Read the existing tests in the file first.)

- [ ] **Step 5: Run (expect fail before bootstrap hook is applied — but Step 3 already added it, so this should PASS)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/workspaces.bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 6: Full suite + typecheck**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
pnpm nx run api:typecheck
```

Expected: 157/157 (156 + 1 new), typecheck green.

- [ ] **Step 7: NO COMMIT.**

---

## Task 5: Gemini SDK install + client wrapper + test mock

**Files:**
- Modify: `apps/api/package.json`
- Create: `apps/api/src/categorize/llm.ts`
- Create: `apps/api/tests/helpers/gemini-mock.ts`

- [ ] **Step 1: Install `@google/genai`**

```bash
pnpm --filter @fina/api add @google/genai@^1
```

Verify in `apps/api/package.json` under `dependencies`.

- [ ] **Step 2: Implement `apps/api/src/categorize/llm.ts`**

```ts
import { GoogleGenAI, Type } from "@google/genai";
import type { Env } from "../env.js";

export type LLMTransaction = {
  id: string;
  merchantRaw: string;
  amount: number;
  occurredAtISO: string; // YYYY-MM-DD
};

export type LLMResult = { tx_id: string; category: string };

/**
 * Call Gemini 2.5 Flash Lite to categorize a batch of transactions.
 *
 * - Merchant strings are JSON-encoded so a malicious merchant name can't
 *   escape the user-message text (prompt-injection defense).
 * - Structured output enforces { results: [{tx_id, category}, ...] } shape.
 * - LLM is told to use exact category names from `categoryNames`; the caller
 *   does case-insensitive validation before assigning.
 * - Throws on network/API/parse errors — caller decides what to do (the
 *   service catches and logs, leaves tx uncategorized).
 */
export async function callGeminiCategorize(
  env: Env,
  categoryNames: string[],
  txs: LLMTransaction[],
): Promise<LLMResult[]> {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  const userPayload = {
    categories: categoryNames,
    transactions: txs.map((t) => ({
      tx_id: t.id,
      merchant: t.merchantRaw,
      amount: t.amount,
      date: t.occurredAtISO,
    })),
  };

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          results: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                tx_id: { type: Type.STRING },
                category: { type: Type.STRING },
              },
              required: ["tx_id", "category"],
            },
          },
        },
        required: ["results"],
      },
      systemInstruction:
        "You categorize Canadian personal financial transactions. CAD currency. " +
        "Positive amount = expense, negative = income/refund. " +
        "Use exact category names from the categories list. If genuinely unclear, use 'Other'.",
    },
    contents: [
      { role: "user", parts: [{ text: JSON.stringify(userPayload) }] },
    ],
  });

  const text = response.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Gemini returned no text");
  }
  // JSON.parse can throw on malformed responses. The caller (service.ts)
  // catches this in the same try/catch as network errors — all failures
  // leave the batch uncategorized per spec.
  const parsed = JSON.parse(text) as { results?: LLMResult[] };
  if (!Array.isArray(parsed.results)) {
    throw new Error(`Gemini response missing results array: ${text.slice(0, 200)}`);
  }
  return parsed.results;
}
```

- [ ] **Step 3: Create `apps/api/tests/helpers/gemini-mock.ts`**

```ts
import { vi } from "vitest";

/**
 * Scriptable Gemini mock for vitest. Mirrors the plaid-mock pattern.
 *
 * Usage (top of every test file that imports anything that imports
 * @google/genai):
 *   import { vi } from "vitest";
 *   import { geminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";
 *
 *   const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
 *     async () => await import("./helpers/gemini-mock.js"),
 *   );
 *   vi.mock("@google/genai", hoistedGeminiMockFactory);
 *
 * Important: vi.mock is hoisted above all imports. `vi.hoisted` lifts the
 * factory's import into that same hoisted scope, otherwise the import
 * binding is in the TDZ when vi.mock fires.
 */

// A queued response is either:
//   - `{ results: [...] }` — Gemini returns valid JSON
//   - `Error`              — the call rejects
//   - `Promise`            — for "pending forever" / "resolves later" tests
type AnyResponse =
  | { results: Array<{ tx_id: string; category: string }> }
  | Error
  | Promise<{ results: Array<{ tx_id: string; category: string }> } | Error>;

export const geminiMock = {
  generateContent: [] as AnyResponse[],
};

export function resetGeminiMock(): void {
  geminiMock.generateContent.length = 0;
}

function pop(): AnyResponse {
  const next = geminiMock.generateContent.shift();
  if (!next) {
    throw new Error("Gemini mock has no scripted response; test forgot to push one");
  }
  return next;
}

async function generateContent() {
  const next = pop();
  if (next && typeof (next as Promise<unknown>).then === "function") {
    const resolved = await (next as Promise<{ results: Array<{ tx_id: string; category: string }> } | Error>);
    if (resolved instanceof Error) throw resolved;
    return { text: JSON.stringify(resolved) };
  }
  if (next instanceof Error) throw next;
  return { text: JSON.stringify(next) };
}

export function geminiMockFactory() {
  return {
    GoogleGenAI: class {
      constructor(_: unknown) {}
      models = { generateContent };
    },
    Type: {
      OBJECT: "object",
      ARRAY: "array",
      STRING: "string",
      NUMBER: "number",
      BOOLEAN: "boolean",
    },
  };
}
```

- [ ] **Step 4: Verify typecheck**

```bash
pnpm nx run api:typecheck
```

Expected: 0 errors. No new tests this task (mock is consumed in Task 6+).

- [ ] **Step 5: Full suite stays green**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 157/157.

- [ ] **Step 6: NO COMMIT.**

---

## Task 6: Categorize service (mapping-first + LLM batch)

**Files:**
- Create: `apps/api/src/categorize/service.ts`
- Create: `apps/api/tests/categorize.service.test.ts`

This is the largest task. The service is the orchestrator: normalize merchants, apply mappings, batch the rest to LLM, write results with race-safe guards.

- [ ] **Step 1: Write failing tests in `apps/api/tests/categorize.service.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { geminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { categorizeNewTransactions } from "../src/categorize/service.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
  CATEGORIZE_BATCH_MAX: 50,
};

beforeEach(async () => {
  await truncateAll();
  resetGeminiMock();
});

afterAll(async () => {
  await disconnect();
});

async function setupWorkspaceWithAccount(): Promise<{ wsId: string; accountId: string; userId: string }> {
  const app = await buildApp(env);
  const u = await signUpAndGetCookie(app, { email: `svc-${Date.now()}@x.com`, name: "SVC" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Checking", type: "depository" },
  });
  await app.close();
  return { wsId, accountId: acct.id, userId: u.userId };
}

async function makeTx(wsId: string, accountId: string, merchant: string, idSuffix = ""): Promise<string> {
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId,
      accountId,
      plaidTransactionId: `pt_${idSuffix || merchant.replace(/\W/g, "")}${Date.now()}`,
      amount: 10,
      merchantRaw: merchant,
      occurredAt: new Date("2026-05-10"),
      rawData: {},
    },
  });
  return tx.id;
}

async function categoryId(wsId: string, name: string): Promise<string> {
  const c = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name } });
  return c.id;
}

// NOTE: `setupWorkspaceWithAccount()` signs up a user, which triggers bootstrap
// and seeds all 11 default categories. Do NOT call prisma.category.createMany()
// for seeded category names (Dining, Groceries, Transit, etc.) — those calls
// will violate the active-name partial unique index and fail.
// Use `await categoryId(wsId, "Dining")` to look up already-seeded categories.
describe("categorizeNewTransactions", () => {
  it("all mapped → no LLM call, source='mapping'", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Categories already seeded by bootstrap.
    const diningId = await categoryId(wsId, "Dining");
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: diningId, source: "manual" },
    });
    const txId = await makeTx(wsId, accountId, "Starbucks");

    // No Gemini push — would throw if called.
    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBe(diningId);
    expect(after.categorizationSource).toBe("mapping");
    expect(after.merchantNormalized).toBe("starbucks");
  });

  it("no mappings → LLM returns valid categories → source='ai'", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "Loblaws");

    geminiMock.generateContent.push({
      results: [{ tx_id: txId, category: "Groceries" }],
    });

    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBe(await categoryId(wsId, "Groceries"));
    expect(after.categorizationSource).toBe("ai");
  });

  it("mixed: 1 mapped, 2 unmapped → LLM called for 2 only", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const diningId = await categoryId(wsId, "Dining");
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: diningId, source: "manual" },
    });
    const mappedId = await makeTx(wsId, accountId, "Starbucks", "a");
    const llmA = await makeTx(wsId, accountId, "Loblaws", "b");
    const llmB = await makeTx(wsId, accountId, "TTC", "c");

    geminiMock.generateContent.push({
      results: [
        { tx_id: llmA, category: "Groceries" },
        { tx_id: llmB, category: "Transit" },
      ],
    });

    await categorizeNewTransactions(env, wsId, [mappedId, llmA, llmB]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: mappedId } })).categorizationSource).toBe("mapping");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: llmA } })).categorizationSource).toBe("ai");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: llmB } })).categorizationSource).toBe("ai");
  });

  it("LLM returns category not in seed → that tx stays uncategorized", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "WeirdShop");

    geminiMock.generateContent.push({
      results: [{ tx_id: txId, category: "InventedCategory" }],
    });

    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBeNull();
    expect(after.categorizationSource).toBeNull();
  });

  it("LLM returns unknown tx_id → skip silently, valid ones still applied", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "Loblaws");

    geminiMock.generateContent.push({
      results: [
        { tx_id: "unknown_tx_id", category: "Groceries" },
        { tx_id: txId, category: "Groceries" },
      ],
    });

    await categorizeNewTransactions(env, wsId, [txId]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })).categorizationSource).toBe("ai");
  });

  it("LLM throws → unmapped tx stay uncategorized; mapped ones still applied", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const diningId = await categoryId(wsId, "Dining");
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: diningId, source: "manual" },
    });
    const mappedId = await makeTx(wsId, accountId, "Starbucks", "a");
    const llmId = await makeTx(wsId, accountId, "Loblaws", "b");

    geminiMock.generateContent.push(new Error("Gemini API down"));

    await categorizeNewTransactions(env, wsId, [mappedId, llmId]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: mappedId } })).categorizationSource).toBe("mapping");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: llmId } })).categoryId).toBeNull();
  });

  it("batch > CATEGORIZE_BATCH_MAX → multiple LLM calls", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const smallEnv = { ...env, CATEGORIZE_BATCH_MAX: 2 };
    const ids = await Promise.all([
      makeTx(wsId, accountId, "M1", "1"),
      makeTx(wsId, accountId, "M2", "2"),
      makeTx(wsId, accountId, "M3", "3"),
    ]);
    geminiMock.generateContent.push({
      results: [
        { tx_id: ids[0]!, category: "Other" },
        { tx_id: ids[1]!, category: "Other" },
      ],
    });
    geminiMock.generateContent.push({
      results: [{ tx_id: ids[2]!, category: "Other" }],
    });

    await categorizeNewTransactions(smallEnv, wsId, ids);

    expect(geminiMock.generateContent.length).toBe(0);
    for (const id of ids) {
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id } })).categorizationSource).toBe("ai");
    }
  });

  it("merchantNormalized is populated on tx rows", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "STARBUCKS #1234 TORONTO ON");
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Other" }] });

    await categorizeNewTransactions(env, wsId, [txId]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })).merchantNormalized).toBe("starbucks");
  });

  it("manual-vs-LLM race: pre-set source='manual' is NOT overwritten", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const groceriesId = await categoryId(wsId, "Groceries");
    const diningId = await categoryId(wsId, "Dining");

    const txId = await makeTx(wsId, accountId, "Loblaws");
    // Simulate a manual write that landed before our service got around to it.
    await prisma.transaction.update({
      where: { id: txId },
      data: { categoryId: diningId, categorizationSource: "manual", merchantNormalized: "loblaws" },
    });

    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Groceries" }] });

    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBe(diningId);             // manual preserved
    expect(after.categorizationSource).toBe("manual");   // NOT overwritten
    expect(after.categoryId).not.toBe(groceriesId);
  });

  it("workspace-scoped category resolution: two workspaces with same category name", async () => {
    const { wsId: wsA, accountId: acctA } = await setupWorkspaceWithAccount();
    const { wsId: wsB } = await setupWorkspaceWithAccount();
    // Both workspaces already have "Groceries" seeded by bootstrap — no createMany needed.
    const txId = await makeTx(wsA, acctA, "Loblaws");
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Groceries" }] });

    await categorizeNewTransactions(env, wsA, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    const wsAGroceries = await categoryId(wsA, "Groceries");
    expect(after.categoryId).toBe(wsAGroceries); // workspace A's Groceries, NOT workspace B's
  });

  it("archived category ignored by LLM (not in passed list)", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    // Archive Dining.
    await prisma.category.update({
      where: { id: await categoryId(wsId, "Dining") },
      data: { archivedAt: new Date() },
    });
    const txId = await makeTx(wsId, accountId, "Restaurant");

    // Even if the mocked LLM returns "Dining", the service must reject it.
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Dining" }] });

    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categoryId).toBeNull(); // stays uncategorized
  });

  it("mapping points to archived category → skipped (tx stays uncategorized OR goes to LLM)", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const diningId = await categoryId(wsId, "Dining");
    await prisma.merchantMapping.create({
      data: { workspaceId: wsId, merchantNormalized: "starbucks", categoryId: diningId, source: "manual" },
    });
    // Archive Dining after the mapping was created.
    await prisma.category.update({ where: { id: diningId }, data: { archivedAt: new Date() } });

    const txId = await makeTx(wsId, accountId, "Starbucks");
    // Mapping is no longer applicable. LLM falls back. Push "Other".
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "Other" }] });

    await categorizeNewTransactions(env, wsId, [txId]);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: txId } });
    expect(after.categorizationSource).toBe("ai"); // mapping skipped, LLM ran
    expect(after.categoryId).toBe(await categoryId(wsId, "Other"));
  });

  it("LLM case-insensitive category match: 'groceries' lower matches 'Groceries' stored", async () => {
    const { wsId, accountId } = await setupWorkspaceWithAccount();
    // Bootstrap already seeded these categories.
    const txId = await makeTx(wsId, accountId, "Loblaws");
    geminiMock.generateContent.push({ results: [{ tx_id: txId, category: "groceries" }] }); // lowercase

    await categorizeNewTransactions(env, wsId, [txId]);

    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: txId } })).categoryId).toBe(
      await categoryId(wsId, "Groceries"),
    );
  });

  it("empty newTxIds → no LLM call, no error", async () => {
    const { wsId } = await setupWorkspaceWithAccount();
    await categorizeNewTransactions(env, wsId, []);
    // geminiMock was never pushed; if it had been called, pop() would throw.
  });
});
```

- [ ] **Step 2: Run (expect fail — module missing)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/categorize.service.test.ts
```

Expected: FAIL — `Failed to load url ../src/categorize/service.js`.

- [ ] **Step 3: Implement `apps/api/src/categorize/service.ts`**

```ts
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { normalizeMerchant } from "./normalize.js";
import { callGeminiCategorize, type LLMTransaction } from "./llm.js";

/**
 * Categorize a list of newly-inserted transactions in a workspace.
 *
 * Flow:
 *  1. For each tx, normalize merchantRaw → store merchantNormalized.
 *  2. Look up merchant_mappings (JOIN active categories only). Mapped tx
 *     get categoryId + source='mapping' instantly.
 *  3. Remaining tx are batched (CATEGORIZE_BATCH_MAX per call) and sent to
 *     Gemini. Valid responses get categoryId + source='ai'.
 *  4. Failures (LLM error, unknown category, unknown tx_id) leave the tx
 *     uncategorized. No retry in the same call.
 *
 * All writes guard by `categorizationSource IS NULL` to avoid overwriting a
 * manual decision that races with our LLM call.
 *
 * Best-effort: this function does NOT throw on Gemini failures. Callers can
 * treat it as fire-and-forget (exchange route) or await it (manual sync).
 */
export async function categorizeNewTransactions(
  env: Env,
  workspaceId: string,
  newTxIds: string[],
): Promise<void> {
  if (newTxIds.length === 0) return;

  // Step 1: Load tx + populate merchantNormalized on each row.
  const txs = await prisma.transaction.findMany({
    where: { id: { in: newTxIds }, workspaceId, categoryId: null },
    select: {
      id: true,
      merchantRaw: true,
      merchantNormalized: true,
      amount: true,
      occurredAt: true,
    },
  });

  type Loaded = { id: string; merchantRaw: string; merchantNormalized: string; amount: number; occurredAt: Date };
  const loaded: Loaded[] = [];
  for (const t of txs) {
    const normalized = t.merchantNormalized ?? normalizeMerchant(t.merchantRaw);
    if (t.merchantNormalized !== normalized) {
      await prisma.transaction.update({
        where: { id: t.id, workspaceId },
        data: { merchantNormalized: normalized },
      });
    }
    loaded.push({
      id: t.id,
      merchantRaw: t.merchantRaw,
      merchantNormalized: normalized,
      amount: Number(t.amount),
      occurredAt: t.occurredAt,
    });
  }

  // Step 2: Mapping lookup (JOIN categories on archivedAt IS NULL — archived
  // mappings don't apply).
  const normalizedSet = [...new Set(loaded.map((t) => t.merchantNormalized))];
  const mappings =
    normalizedSet.length === 0
      ? []
      : await prisma.merchantMapping.findMany({
          where: {
            workspaceId,
            merchantNormalized: { in: normalizedSet },
            category: { archivedAt: null },
          },
          select: { merchantNormalized: true, categoryId: true },
        });
  const mappingByNorm = new Map(mappings.map((m) => [m.merchantNormalized, m.categoryId]));

  const unmapped: Loaded[] = [];
  for (const t of loaded) {
    const catId = mappingByNorm.get(t.merchantNormalized);
    if (catId) {
      await prisma.transaction.updateMany({
        where: { id: t.id, workspaceId, categorizationSource: null },
        data: { categoryId: catId, categorizationSource: "mapping" },
      });
    } else {
      unmapped.push(t);
    }
  }
  if (unmapped.length === 0) return;

  // Step 3: LLM batch. Build workspace-scoped active category map.
  const categoryRows = await prisma.category.findMany({
    where: { workspaceId, archivedAt: null },
    select: { id: true, name: true },
  });
  const categoryByLower = new Map(categoryRows.map((c) => [c.name.toLowerCase(), c.id]));
  const categoryNames = categoryRows.map((c) => c.name);
  if (categoryNames.length === 0) return; // no vocabulary, nothing to do

  const batchMax = env.CATEGORIZE_BATCH_MAX ?? 50; // optional field; default in code not zod
  for (let i = 0; i < unmapped.length; i += batchMax) {
    const batch = unmapped.slice(i, i + batchMax);
    const llmTxs: LLMTransaction[] = batch.map((t) => ({
      id: t.id,
      merchantRaw: t.merchantRaw,
      amount: t.amount,
      occurredAtISO: t.occurredAt.toISOString().slice(0, 10),
    }));

    let results: Array<{ tx_id: string; category: string }> = [];
    try {
      results = await callGeminiCategorize(env, categoryNames, llmTxs);
    } catch (e) {
      // Log + continue. Tx in this batch stay uncategorized.
      // NOTE: callGeminiCategorize may throw on network errors OR on
      // JSON.parse failure (malformed structured response). Both are caught
      // here so the "best-effort, leave uncategorized" contract holds.
      console.error("[categorize] Gemini batch failed", e);
      continue;
    }

    const batchIdSet = new Set(batch.map((t) => t.id));
    for (const r of results) {
      if (!batchIdSet.has(r.tx_id)) continue;
      const catId = categoryByLower.get(r.category.toLowerCase());
      if (!catId) continue;
      await prisma.transaction.updateMany({
        where: { id: r.tx_id, workspaceId, categorizationSource: null },
        data: { categoryId: catId, categorizationSource: "ai" },
      });
    }
  }
}
```

- [ ] **Step 4: Run tests (expect 15/15 pass)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/categorize.service.test.ts
```

Expected: 15/15 PASS.

- [ ] **Step 5: Full suite + typecheck**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
pnpm nx run api:typecheck
```

Expected: 172/172 (157 + 15), typecheck green.

- [ ] **Step 6: NO COMMIT.**

---

## Task 7: Augment `syncTransactions` to return `newTxIds`

**Files:**
- Modify: `apps/api/src/plaid/sync.ts`
- Modify: `apps/api/tests/plaid.sync.test.ts`

`syncTransactions` currently returns `{added, modified, removed} | {skipped, added, modified, removed}`. We add `newTxIds: string[]` to both variants and change `upsertAdded` to signal whether it inserted vs updated.

- [ ] **Step 1: Add failing tests to `apps/api/tests/plaid.sync.test.ts`** (append at the end of the existing describe block)

```ts
  it("returns newTxIds for fresh inserts only — promotion excluded", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ntx-prom@x.com", name: "P" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    // Sync 1: pending row arrives.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "pend_n1", account_id: "acct_test", amount: 5, date: "2026-05-10", pending: true })],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    const r1 = await syncTransactions(env, wsId, plaidItemId);
    expect("newTxIds" in r1).toBe(true);
    expect((r1 as { newTxIds: string[] }).newTxIds).toHaveLength(1);

    // Sync 2: posted row promotes the pending one — update, not insert.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "post_n1", account_id: "acct_test", amount: 5, date: "2026-05-11", pending: false, pending_transaction_id: "pend_n1" })],
        modified: [], removed: [], next_cursor: "c2", has_more: false,
      },
    });
    const r2 = await syncTransactions(env, wsId, plaidItemId);
    expect("newTxIds" in r2).toBe(true);
    expect((r2 as { newTxIds: string[] }).newTxIds).toHaveLength(0); // promoted = updated, not new
    await app.close();
  });

  it("returns newTxIds: multi-page run accumulates fresh inserts across pages", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ntx-multi@x.com", name: "M" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push(
      { data: { added: [tx({ transaction_id: "p1a", account_id: "acct_test", amount: 1, date: "2026-05-09" })], modified: [], removed: [], next_cursor: "c1", has_more: true } },
      { data: { added: [tx({ transaction_id: "p2a", account_id: "acct_test", amount: 2, date: "2026-05-10" })], modified: [], removed: [], next_cursor: "c2", has_more: false } },
    );
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect("newTxIds" in r).toBe(true);
    expect((r as { newTxIds: string[] }).newTxIds).toHaveLength(2);
    await app.close();
  });
```

- [ ] **Step 2: Run (expect fail — `newTxIds` not in SyncResult yet)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.sync.test.ts
```

Expected: FAIL with TS error or missing property.

- [ ] **Step 3: Modify `apps/api/src/plaid/sync.ts`**

**3a. Update the `SyncResult` type** (around the top of the file):

```ts
export type SyncResult =
  | { added: number; modified: number; removed: number; newTxIds: string[] }
  | { skipped: "lock_held"; added: number; modified: number; removed: number; newTxIds: string[] };
```

**3b. Update `upsertAdded` return type and body** — change the signature to:

```ts
export async function upsertAdded(
  tx: Prisma.TransactionClient,
  t: PlaidTxLike,
  plaidItemId: string,
  workspaceId: string,
): Promise<{ kind: "inserted" | "updated"; localId: string }> {
```

In the promotion branch, return `{ kind: "updated", localId: promotion.id }` after the update.

In the fresh-insert path (after the `findFirst` lookup):
- If found existing row → update → return `{ kind: "updated", localId: existing.id }`
- If not found → create → return `{ kind: "inserted", localId: created.id }`

**3c. Update the page loop** in `syncTransactions` to collect `newTxIds`:

```ts
let added = 0, modified = 0, removed = 0;
const newTxIds: string[] = [];           // NEW
let restarts = 0;

try {
  pageLoop: while (true) {
    // ... existing Plaid fetch + mutation-restart handling ...

    try {
      await prisma.$transaction(async (tx) => {
        await lockPlaidItem(tx, plaidItemId);
        for (const t of pageData.added) {
          const result = await upsertAdded(tx, t, plaidItemId, workspaceId);
          if (result.kind === "inserted") newTxIds.push(result.localId);    // NEW
          added++;
        }
        for (const t of pageData.modified) { await upsertModified(tx, t, workspaceId); modified++; }
        for (const t of pageData.removed)  { await markRemoved(tx, t.transaction_id, workspaceId); removed++; }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (e) {
      if (e instanceof SyncLockHeld) {
        return { skipped: "lock_held", added, modified, removed, newTxIds };  // NEW shape
      }
      throw e;
    }
    // ...
  }
```

**3d. Mutation-restart MUST NOT clear `newTxIds`** — only the counters:

```ts
        if (isPlaidErrorCode(e, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")) {
          restarts++;
          if (restarts > MAX_MUTATION_RESTARTS) { throw e; }
          cursor = originalCursor;
          added = modified = removed = 0;
          // NOTE: newTxIds is NOT reset — committed inserts from prior pages
          // are durable and need categorizing on the next attempt's
          // findFirst-update branch.
          continue pageLoop;
        }
```

**3e. Final-tx lock_held branch also returns `newTxIds`**:

```ts
    try {
      await prisma.$transaction(async (tx) => {
        await lockPlaidItem(tx, plaidItemId);
        await tx.plaidItem.update({ /* ... existing ... */ });
      });
    } catch (e) {
      if (e instanceof SyncLockHeld) {
        return { skipped: "lock_held", added, modified, removed, newTxIds };  // NEW shape
      }
      throw e;
    }

    return { added, modified, removed, newTxIds };   // NEW shape
```

- [ ] **Step 4: Run sync tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.sync.test.ts
```

Expected: ALL tests pass (existing 10 + 2 new = 12).

- [ ] **Step 5: Full suite — may have downstream failures**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 174/174 (172 + 2). If `plaid.exchange.test.ts` or `plaid.routes.test.ts` fails because they destructure `SyncResult` without `newTxIds`, fix the callers in Tasks 8/9.

- [ ] **Step 6: Typecheck**

```bash
pnpm nx run api:typecheck
```

Expected: 0 errors.

- [ ] **Step 7: NO COMMIT.**

---

## Task 8: Exchange route — detached categorize promise

**Files:**
- Modify: `apps/api/src/routes/plaid.ts`
- Modify: `apps/api/tests/plaid.exchange.test.ts`

The exchange route's response budget is the 30 s soft timeout. Categorize must not extend that. We fire it as a detached promise after the sync `Promise.race` resolves.

- [ ] **Step 1: Modify `apps/api/src/routes/plaid.ts`** — the exchange handler

In the `Promise.race` block (around the existing `syncTransactions` call), capture the result. After the `if ("skipped" in r) / else` block, fire categorize:

```ts
// ... existing Promise.race + skipped/deadline handling ...
} else {
  transactionCount = r.added;
}

// Detached categorize — keeps the response fast. Errors are logged.
// The `newTxIds` may be empty (all promotions) or non-empty (fresh inserts).
if ("newTxIds" in r && r.newTxIds.length > 0) {
  const newTxIds = r.newTxIds; // capture for closure
  void categorizeNewTransactions(app.fina.env, verifiedWsId, newTxIds).catch((e) => {
    app.log.error({ err: e, plaidItemId, workspace: verifiedWsId }, "categorize after exchange failed");
  });
}
```

Add the import at the top of the file:

```ts
import { categorizeNewTransactions } from "../categorize/service.js";
```

(`r.skipped === "deadline"` is the synthesized deadline-promise result; it has no `newTxIds`. The `"newTxIds" in r` check handles both real SyncResult variants.)

- [ ] **Step 2: Add tests to `apps/api/tests/plaid.exchange.test.ts`**

Update the existing `vi.mock` block to mock Gemini too. At the top of the file, after the existing plaid mock:

```ts
import { geminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);
```

Add `resetGeminiMock()` to the existing `beforeEach`. Then append at the end of the exchange describe block:

```ts
  it("detached categorize after exchange — tx get categoryId + source='ai' within poll window", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ex-cat@x.com", name: "EC" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_cat");
    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "tx_cat", account_id: "acct_1", amount: 5, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "Loblaws", name: "Loblaws", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Look up the real local tx id so the Gemini mock returns the right id.
    const localTx = await prisma.transaction.findFirstOrThrow({
      where: { workspaceId: wsId, plaidTransactionId: "tx_cat" },
      select: { id: true },
    });

    // Now push the mock with the real id — the detached promise hasn't fired yet
    // (it's awaiting the Gemini call which pops from the queue).
    geminiMock.generateContent.push({
      results: [{ tx_id: localTx.id, category: "Groceries" }],
    });

    // Allow the detached categorize promise to execute.
    await new Promise((r) => setTimeout(r, 800));
    expect(geminiMock.generateContent.length).toBe(0); // consumed

    // Assert the tx actually got categorized.
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: localTx.id } });
    const groceriesCat = await prisma.category.findFirstOrThrow({
      where: { workspaceId: wsId, name: "Groceries" },
    });
    expect(after.categoryId).toBe(groceriesCat.id);
    expect(after.categorizationSource).toBe("ai");
    await app.close();
  });

  it("detached categorize: Gemini failure does NOT break exchange response", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ex-cat-fail@x.com", name: "ECF" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_cat_fail");
    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "tx_fail", account_id: "acct_1", amount: 5, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "Costco", name: "Costco", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    geminiMock.generateContent.push(new Error("Gemini down"));

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncOk).toBe(true);  // sync itself succeeded
    // Let the detached promise resolve.
    await new Promise((r) => setTimeout(r, 500));
    await app.close();
  });
```

- [ ] **Step 3: Run exchange tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.exchange.test.ts
```

Expected: 14/14 PASS (12 prior + 2 new).

- [ ] **Step 4: Full suite + typecheck**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
pnpm nx run api:typecheck
```

Expected: 176/176, typecheck green.

- [ ] **Step 5: NO COMMIT.**

---

## Task 9: Manual sync route — awaited categorize

**Files:**
- Modify: `apps/api/src/routes/plaid-items.ts`
- Modify: `apps/api/tests/plaid.routes.test.ts`

The manual sync route (`POST /plaid-items/:itemId/sync`) doesn't have a soft deadline; the caller is okay waiting for categorize to finish so the response reflects final state.

- [ ] **Step 1: Modify `apps/api/src/routes/plaid-items.ts`** — the sync handler

After the existing `syncTransactions` call returns `r`, add an awaited categorize call:

```ts
const r = await syncTransactions(app.fina.env, ctx.membership.workspaceId, params.itemId);
// Await categorize so the response reflects the final categorized state.
// Best-effort: errors are caught inside categorizeNewTransactions.
if ("newTxIds" in r && r.newTxIds.length > 0) {
  await categorizeNewTransactions(app.fina.env, ctx.membership.workspaceId, r.newTxIds);
}
return r;
```

Import at top:

```ts
import { categorizeNewTransactions } from "../categorize/service.js";
```

- [ ] **Step 2: Add test to `apps/api/tests/plaid.routes.test.ts`**

The existing `vi.mock("plaid", ...)` should already be there. Add gemini mock:

```ts
import { geminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);
```

In the existing `beforeEach`, add `resetGeminiMock()`.

Append a test in the existing "POST /workspaces/:id/plaid-items/:itemId/sync" describe:

```ts
  it("manual sync awaits categorize — response reflects categoryId set", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ms-cat@x.com", name: "MS" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "tx_msync", account_id: "acct", amount: 5, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "Loblaws", name: "Loblaws", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "c2", has_more: false,
      },
    });

    // Intercept the Gemini call with a factory that:
    //   (a) returns a pending promise initially
    //   (b) resolves it with the real tx id AFTER the response is sent
    // This is simpler: push a result using the plaid_transaction_id to find
    // the local row first. But since sync runs categorize synchronously (await),
    // the tx is created before the Gemini call fires. We can look it up after
    // the response.
    //
    // Practical test: push a placeholder and assert Gemini was consumed.
    // Then assert the DB state.
    const syncPlaidTxId = "tx_msync";
    // Push a deferred handler that resolves with the real local id.
    let geminiResolve!: (r: { results: Array<{ tx_id: string; category: string }> }) => void;
    geminiMock.generateContent.push(
      new Promise<{ results: Array<{ tx_id: string; category: string }> }>((r) => { geminiResolve = r; }),
    );

    // Start the inject — it will await categorize (which blocks on Gemini mock promise).
    const resPromise = app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    // Give the route a moment to get to the Gemini await.
    await new Promise((r) => setTimeout(r, 200));

    // Now we can look up the real local tx id.
    const localTx = await prisma.transaction.findFirstOrThrow({
      where: { workspaceId: wsId, plaidTransactionId: syncPlaidTxId },
      select: { id: true },
    });
    // Resolve the Gemini promise with the real id.
    geminiResolve({ results: [{ tx_id: localTx.id, category: "Groceries" }] });

    const res = await resPromise;
    expect(res.statusCode).toBe(200);
    expect(geminiMock.generateContent.length).toBe(0); // consumed

    // Verify the tx was actually categorized (categorize was awaited).
    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: localTx.id } });
    const groceriesCat = await prisma.category.findFirstOrThrow({
      where: { workspaceId: wsId, name: "Groceries" },
    });
    expect(after.categoryId).toBe(groceriesCat.id);
    expect(after.categorizationSource).toBe("ai");
    await app.close();
  });
```

- [ ] **Step 3: Run routes tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.routes.test.ts
```

Expected: 23/23 PASS (22 prior + 1 new).

- [ ] **Step 4: Full suite + typecheck**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
pnpm nx run api:typecheck
```

Expected: 177/177, typecheck green.

- [ ] **Step 5: NO COMMIT.**

---

## Task 10: Categories CRUD routes

**Files:**
- Create: `apps/api/src/routes/categories.ts`
- Modify: `apps/api/src/server.ts` (register the new plugin)
- Create: `apps/api/tests/categorize.routes.test.ts` (categories portion — manual categorize comes in Task 11)

- [ ] **Step 1: Write failing tests in `apps/api/tests/categorize.routes.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { plaidMock, resetPlaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { geminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";
const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
  CATEGORIZE_BATCH_MAX: 50,
};

beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
  resetGeminiMock();
});

afterAll(async () => {
  await disconnect();
});

describe("GET /workspaces/:id/categories", () => {
  it("seeded user has 11 default categories", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "cat-list@x.com", name: "CL" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const names = (res.json().categories as Array<{ name: string }>).map((c) => c.name).sort();
    expect(names).toEqual([
      "Dining", "Entertainment", "Groceries", "Health", "Housing",
      "Income", "Other", "Shopping", "Subscriptions", "Transit", "Utilities",
    ]);
    await app.close();
  });

  it("404 for non-member workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "cat-nm@x.com", name: "NM" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/categories`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /workspaces/:id/categories", () => {
  it("owner creates new category", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-mk@x.com", name: "Mk" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Hobbies" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().category.name).toBe("Hobbies");
    await app.close();
  });

  it("editor cannot create — 403", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-ed-o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const editor = await signUpAndGetCookie(app, { email: "cat-ed-e@x.com", name: "E" });
    await prisma.membership.create({
      data: { userId: editor.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: editor.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Hobbies" }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("duplicate name (exact case) — 422", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-dup@x.com", name: "D" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Groceries" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("duplicate_name");
    await app.close();
  });

  it("duplicate name (case-insensitive) — 422", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-dup-ci@x.com", name: "DC" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "groceries" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("duplicate_name");
    await app.close();
  });

  it("name length 41 → 400 invalid_body", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-long@x.com", name: "L" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "X".repeat(41) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
    await app.close();
  });

  it("30 active categories cap — 422 on the 31st", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-cap@x.com", name: "C" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // Seeded 11 + we add 19 more = 30
    for (let i = 0; i < 19; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/categories`,
        headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
        payload: JSON.stringify({ name: `Cat${i}` }),
      });
      expect(r.statusCode).toBe(201);
    }
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "CatTooMany" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("too_many_categories");
    await app.close();
  });

  it("workspace_mismatch — 400", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-wm@x.com", name: "WM" });
    const wsA = await getOwnerWorkspaceId(owner.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsA, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Hobbies" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});

describe("PATCH /workspaces/:id/categories/:catId", () => {
  it("owner renames category", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-ren@x.com", name: "R" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const cat = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Other" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/categories/${cat.id}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Misc" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().category.name).toBe("Misc");
    await app.close();
  });

  it("rename to existing active name → 422", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-ren-dup@x.com", name: "RD" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const other = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Other" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/categories/${other.id}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Groceries" }),
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("archive then create same-name (different case) → success", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-archrec@x.com", name: "AR" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const groc = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Groceries" } });
    // Archive
    const arc = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/categories/${groc.id}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ archived: true }),
    });
    expect(arc.statusCode).toBe(200);
    // Recreate with different case
    const rec = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "groceries" }),
    });
    expect(rec.statusCode).toBe(201);
    await app.close();
  });
});
```

- [ ] **Step 2: Run (expect fail — route doesn't exist)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/categorize.routes.test.ts
```

Expected: FAIL — 404 for all routes (route not registered).

- [ ] **Step 3: Implement `apps/api/src/routes/categories.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";

const MAX_NAME_LEN = 40;
const MAX_ACTIVE_CATEGORIES = 30;

// Use .trim() BEFORE .min(1) so "   " (only spaces) is rejected as empty.
const CreateBody = z.object({ name: z.string().trim().min(1).max(MAX_NAME_LEN) });

const PatchBody = z.object({
  name: z.string().min(1).max(MAX_NAME_LEN).optional(),
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  archived: z.boolean().optional(),
});

export async function categoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/categories", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const cats = await prisma.category.findMany({
        where: { workspaceId: ctx.membership.workspaceId, archivedAt: null },
        orderBy: { name: "asc" },
        select: { id: true, name: true, icon: true, color: true },
      });
      return { categories: cats };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post("/workspaces/:id/categories", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }

      const wsId = ctx.membership.workspaceId;
      const nameTrim = parsed.data.name.trim();

      // Count active categories
      const activeCount = await prisma.category.count({
        where: { workspaceId: wsId, archivedAt: null },
      });
      if (activeCount >= MAX_ACTIVE_CATEGORIES) {
        return reply.code(422).send({ error: "too_many_categories" });
      }

      // Case-insensitive active duplicate check
      const dup = await prisma.category.findFirst({
        where: {
          workspaceId: wsId,
          archivedAt: null,
          name: { equals: nameTrim, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (dup) return reply.code(422).send({ error: "duplicate_name" });

      const created = await prisma.category.create({
        data: { workspaceId: wsId, name: nameTrim },
        select: { id: true, name: true, icon: true, color: true },
      });
      return reply.code(201).send({ category: created });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.patch("/workspaces/:id/categories/:catId", async (req, reply) => {
    const params = req.params as { id: string; catId: string };
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }

      const wsId = ctx.membership.workspaceId;
      const existing = await prisma.category.findUnique({
        where: { id: params.catId },
        select: { id: true, workspaceId: true, name: true },
      });
      if (!existing || existing.workspaceId !== wsId) {
        return reply.code(404).send({ error: "not_found" });
      }

      // Build a properly-typed update object (Record<string,unknown> would
      // fail strict Prisma assignability checks).
      type CategoryPatch = {
        name?: string;
        icon?: string | null;
        color?: string | null;
        archivedAt?: Date | null;
      };
      const data: CategoryPatch = {};
      if (parsed.data.name !== undefined) {
        const nameTrim = parsed.data.name.trim();
        if (nameTrim.toLowerCase() !== existing.name.toLowerCase()) {
          const dup = await prisma.category.findFirst({
            where: {
              workspaceId: wsId,
              archivedAt: null,
              name: { equals: nameTrim, mode: "insensitive" },
              id: { not: params.catId },
            },
            select: { id: true },
          });
          if (dup) return reply.code(422).send({ error: "duplicate_name" });
        }
        data.name = nameTrim;
      }
      if (parsed.data.icon !== undefined) data.icon = parsed.data.icon;
      if (parsed.data.color !== undefined) data.color = parsed.data.color;
      if (parsed.data.archived !== undefined) {
        // Unarchiving: check the 30-category cap so we don't exceed it on restore.
        if (!parsed.data.archived) {
          const activeCount = await prisma.category.count({
            where: { workspaceId: wsId, archivedAt: null },
          });
          if (activeCount >= MAX_ACTIVE_CATEGORIES) {
            return reply.code(422).send({ error: "too_many_categories" });
          }
        }
        data.archivedAt = parsed.data.archived ? new Date() : null;
      }

      const updated = await prisma.category.update({
        where: { id: params.catId },
        data,
        select: { id: true, name: true, icon: true, color: true, archivedAt: true },
      });
      return { category: updated };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 4: Register in `apps/api/src/server.ts`**

```ts
import { categoriesRoutes } from "./routes/categories.js";
```

After `await app.register(transactionsRoutes);`:

```ts
  await app.register(categoriesRoutes);
```

- [ ] **Step 5: Run categorize.routes tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/categorize.routes.test.ts
```

Expected: 11/11 PASS.

- [ ] **Step 6: Full suite + typecheck**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
pnpm nx run api:typecheck
```

Expected: 188/188 (177 + 11), typecheck green.

- [ ] **Step 7: NO COMMIT.**

---

## Task 11: Manual categorize route + back-fill

**Files:**
- Modify: `apps/api/src/routes/transactions.ts` (add `POST /:txId/categorize`)
- Modify: `apps/api/tests/categorize.routes.test.ts` (append)

The manual categorize handler: resolve category (active only), update tx (source='manual'), upsert merchant_mapping, normalize NULL siblings, back-fill siblings (source NULL or != 'manual').

- [ ] **Step 1: Append failing tests to `apps/api/tests/categorize.routes.test.ts`**

```ts
describe("POST /workspaces/:id/transactions/:txId/categorize", () => {
  async function setupTx(wsIdEmail: string): Promise<{ wsId: string; cookie: string; txId: string; loblawsTxId: string }> {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: wsIdEmail, name: "U" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Checking", type: "depository" },
    });
    const tx1 = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: `pt_${Date.now()}`,
        amount: 5, merchantRaw: "Starbucks", occurredAt: new Date("2026-05-10"), rawData: {},
      },
    });
    // A sibling Starbucks tx (uncategorized) to verify back-fill
    const tx2 = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: `pt2_${Date.now()}`,
        amount: 6, merchantRaw: "Starbucks", occurredAt: new Date("2026-05-09"), rawData: {},
      },
    });
    await app.close();
    return { wsId, cookie: u.cookie, txId: tx1.id, loblawsTxId: tx2.id };
  }

  it("happy path — tx updated, mapping created, siblings back-filled", async () => {
    const { wsId, cookie, txId, loblawsTxId: siblingId } = await setupTx("manual-cat@x.com");
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transaction.categorizationSource).toBe("manual");
    expect(body.backfilledCount).toBe(1);

    // Sibling should now be source='mapping'
    const sibling = await prisma.transaction.findUniqueOrThrow({ where: { id: siblingId } });
    expect(sibling.categorizationSource).toBe("mapping");
    // Mapping row exists
    const m = await prisma.merchantMapping.findFirstOrThrow({
      where: { workspaceId: wsId, merchantNormalized: "starbucks" },
    });
    expect(m.source).toBe("manual");
    await app.close();
  });

  it("viewer caller — 403", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "mc-o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const viewer = await signUpAndGetCookie(app, { email: "mc-v@x.com", name: "V" });
    await prisma.membership.create({ data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" } });
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Checking", type: "depository" },
    });
    const t = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct.id, plaidTransactionId: `vc${Date.now()}`, amount: 1, merchantRaw: "X", occurredAt: new Date(), rawData: {} },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${t.id}/categorize`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("category doesn't exist — 404", async () => {
    const { wsId, cookie, txId } = await setupTx("mc-404@x.com");
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "NonExistent" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("category_not_found");
    await app.close();
  });

  it("category archived — 404 (active-only resolution)", async () => {
    const { wsId, cookie, txId } = await setupTx("mc-arc@x.com");
    const app = await buildApp(env);
    await prisma.category.updateMany({
      where: { workspaceId: wsId, name: "Dining" },
      data: { archivedAt: new Date() },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("back-fill skips manual-source siblings", async () => {
    const { wsId, cookie, txId, loblawsTxId: siblingId } = await setupTx("mc-skip-manual@x.com");
    // Pre-set sibling as manual
    const groceriesCat = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Groceries" } });
    await prisma.transaction.update({
      where: { id: siblingId },
      data: { categoryId: groceriesCat.id, categorizationSource: "manual", merchantNormalized: "starbucks" },
    });

    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(200);

    // Sibling should KEEP its manual Groceries
    const sibling = await prisma.transaction.findUniqueOrThrow({ where: { id: siblingId } });
    expect(sibling.categoryId).toBe(groceriesCat.id);
    expect(sibling.categorizationSource).toBe("manual");
    await app.close();
  });

  it("back-fill normalizes NULL-merchantNormalized siblings before applying", async () => {
    const { wsId, cookie, txId } = await setupTx("mc-null-mn@x.com");
    const acct = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: wsId } });
    // Create a legacy sibling with NULL merchantNormalized
    const legacy = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: `legacy_${Date.now()}`,
        amount: 7, merchantRaw: "Starbucks", occurredAt: new Date("2026-05-08"), rawData: {},
        // merchantNormalized intentionally left NULL
      },
    });
    expect(legacy.merchantNormalized).toBeNull();

    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after.merchantNormalized).toBe("starbucks");   // normalized
    expect(after.categorizationSource).toBe("mapping");   // back-filled
    await app.close();
  });

  it("workspace_mismatch — 400", async () => {
    const { wsId, cookie, txId } = await setupTx("mc-wm@x.com");
    const wsB = (await prisma.workspace.create({ data: { name: "B" } })).id;
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});
```

- [ ] **Step 2: Run (expect fail — route not implemented)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/categorize.routes.test.ts
```

Expected: FAIL — 404 for the categorize action.

- [ ] **Step 3: Modify `apps/api/src/routes/transactions.ts`**

Add the POST handler. Read the existing file to find where the GET handler ends, then add this AFTER it inside the `transactionsRoutes` function:

```ts
import { normalizeMerchant } from "../categorize/normalize.js";

// Inside transactionsRoutes, add new handler:

const CategorizeBody = z.object({ categoryName: z.string().min(1).max(80) });

app.post("/workspaces/:id/transactions/:txId/categorize", async (req, reply) => {
  const params = req.params as { id: string; txId: string };
  const parsed = CategorizeBody.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
  try {
    const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
    if (ctx.membership.workspaceId !== params.id) {
      return reply.code(400).send({ error: "workspace_mismatch" });
    }
    const wsId = ctx.membership.workspaceId;
    const trimmedName = parsed.data.categoryName.trim();

    // 1. Load tx (verify workspace ownership).
    const tx = await prisma.transaction.findFirst({
      where: { id: params.txId, workspaceId: wsId },
      select: { id: true, merchantRaw: true, merchantNormalized: true },
    });
    if (!tx) return reply.code(404).send({ error: "not_found" });

    // Compute merchantNormalized if missing.
    const merchantNorm = tx.merchantNormalized ?? normalizeMerchant(tx.merchantRaw);

    // 2. Resolve category (active only, case-insensitive).
    const category = await prisma.category.findFirst({
      where: {
        workspaceId: wsId,
        archivedAt: null,
        name: { equals: trimmedName, mode: "insensitive" },
      },
      select: { id: true, name: true },
    });
    if (!category) return reply.code(404).send({ error: "category_not_found" });

    // 3. Apply tx + 4. upsert mapping + 5. normalize null siblings + 6. back-fill, all in one tx.
    const result = await prisma.$transaction(async (db) => {
      // 3. Tx update with merchantNormalized backfill
      await db.transaction.update({
        where: { id: tx.id },
        data: {
          merchantNormalized: merchantNorm,
          categoryId: category.id,
          categorizationSource: "manual",
        },
      });

      // 4. Upsert merchant_mapping
      await db.merchantMapping.upsert({
        where: { workspaceId_merchantNormalized: { workspaceId: wsId, merchantNormalized: merchantNorm } },
        create: {
          workspaceId: wsId,
          merchantNormalized: merchantNorm,
          categoryId: category.id,
          confidence: 1.0,
          source: "manual",
        },
        update: {
          categoryId: category.id,
          source: "manual",
          confidence: 1.0,
        },
      });

      // 5. Normalize null-merchantNormalized siblings — load candidates whose
      //    raw merchant looks similar and normalize them lazily.
      const nullSiblings = await db.transaction.findMany({
        where: {
          workspaceId: wsId,
          merchantNormalized: null,
          merchantRaw: { mode: "insensitive", contains: trimmedName.length >= 3 ? merchantNorm.slice(0, 3) : merchantNorm },
        },
        select: { id: true, merchantRaw: true },
      });
      for (const ns of nullSiblings) {
        const norm = normalizeMerchant(ns.merchantRaw);
        if (norm === merchantNorm) {
          await db.transaction.update({
            where: { id: ns.id },
            data: { merchantNormalized: norm },
          });
        }
      }

      // 6. Back-fill: update siblings sharing the normalized merchant, skipping
      //    the just-updated tx and any siblings already manually categorized.
      //    NULL-safe predicate handles tx with categorizationSource = NULL.
      const backfilled = await db.transaction.updateMany({
        where: {
          workspaceId: wsId,
          merchantNormalized: merchantNorm,
          id: { not: tx.id },
          OR: [
            { categorizationSource: null },
            { categorizationSource: { not: "manual" } },
          ],
        },
        data: { categoryId: category.id, categorizationSource: "mapping" },
      });

      return { backfilledCount: backfilled.count };
    });

    const updated = await prisma.transaction.findUniqueOrThrow({
      where: { id: tx.id },
      select: {
        id: true, amount: true, merchantRaw: true, merchantNormalized: true,
        categoryId: true, categorizationSource: true, occurredAt: true,
      },
    });
    return {
      transaction: {
        ...updated,
        amount: updated.amount.toString(),
        occurredAt: updated.occurredAt.toISOString(),
      },
      backfilledCount: result.backfilledCount,
    };
  } catch (e) {
    if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
    throw e;
  }
});
```

- [ ] **Step 4: Run categorize.routes tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/categorize.routes.test.ts
```

Expected: 18/18 PASS (11 prior + 7 new).

- [ ] **Step 5: Full suite + typecheck**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
pnpm nx run api:typecheck
```

Expected: 195/195, typecheck green.

- [ ] **Step 6: NO COMMIT.**

---

## Task 12: `?uncategorizedOnly=true` filter on existing transactions route

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Modify: `apps/api/tests/plaid.routes.test.ts`

- [ ] **Step 1: Modify the existing `QuerySchema` in `apps/api/src/routes/transactions.ts`**

Find the `QuerySchema` definition. Add `uncategorizedOnly` field with the same `BoolFlag` parser pattern that `includeRemoved` uses:

```ts
const BoolFlag = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional()
  .default("false");

const QuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  accountId: z.string().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  includeRemoved: BoolFlag,
  uncategorizedOnly: BoolFlag, // NEW
});
```

In the `where` clause builder in the handler, add a clause when `uncategorizedOnly` is true:

```ts
const where = {
  workspaceId: ctx.membership.workspaceId,
  ...(q.accountId ? { accountId: q.accountId } : {}),
  // ... existing from/to/includeRemoved logic ...
  ...(q.uncategorizedOnly ? { categoryId: null } : {}),
  // ... existing cursor logic ...
};
```

- [ ] **Step 2: Add tests to `apps/api/tests/plaid.routes.test.ts`** — `GET /workspaces/:id/transactions` describe

```ts
  it("?uncategorizedOnly=true filters to NULL categoryId only", async () => {
    const app = await buildApp(env);
    const { owner, wsId } = await setupItemAndTxs(app, 3);
    // Categorize one of them.
    const cat = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Other" } });
    const tx = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    await prisma.transaction.update({
      where: { id: tx.id },
      data: { categoryId: cat.id, categorizationSource: "manual" },
    });

    const all = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(all.json().transactions.length).toBe(3);

    const uncat = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?uncategorizedOnly=true`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(uncat.json().transactions.length).toBe(2);
    expect(uncat.json().transactions.every((t: { categoryId: string | null }) => t.categoryId === null)).toBe(true);
    await app.close();
  });
```

- [ ] **Step 3: Run tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.routes.test.ts
```

Expected: 24/24 PASS (23 prior + 1 new).

- [ ] **Step 4: Full suite + typecheck**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
pnpm nx run api:typecheck
```

Expected: 196/196, typecheck green.

- [ ] **Step 5: NO COMMIT.**

---

## Task 13: E2E — Plaid sandbox connect → auto-categorize → manual re-categorize → back-fill

**Files:**
- Create: `e2e/plan-1b-categorize.spec.ts`

This is real-Gemini E2E (only runs if `GEMINI_API_KEY` set). Mirrors the Plan 1B-foundation Plaid sandbox pattern.

- [ ] **Step 1: Create `e2e/plan-1b-categorize.spec.ts`**

```ts
import { test, expect } from "@playwright/test";
import { signUp, uniqueEmail } from "./helpers/auth";

const API = process.env.API_URL ?? "http://localhost:4000";
const HAS_PLAID = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
const HAS_GEMINI = !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== "test_gemini_key";

test.describe("plan 1b-categorize E2E", () => {
  test.skip(!HAS_PLAID || !HAS_GEMINI, "Requires PLAID_CLIENT_ID + PLAID_SECRET + real GEMINI_API_KEY");

  test("Plaid sandbox connect → auto-categorize → manual recategorize back-fills", async ({ page, request }) => {
    const email = uniqueEmail("cat");
    await signUp(page, email);

    // Use the Plaid Link sandbox flow (same as Plan 1B-foundation E2E).
    await page.goto("/settings/banks");
    await page.getByRole("button", { name: /connect a bank/i }).click();
    const plaidFrame = page.frameLocator('iframe[id^="plaid-link-iframe"]');
    const skipPhone = plaidFrame.getByRole("button", { name: /continue without phone/i });
    await skipPhone.waitFor({ timeout: 12_000 });
    await skipPhone.click();
    await page.waitForTimeout(1_500);
    const searchInput = plaidFrame.locator('input[placeholder="Search"]');
    await searchInput.waitFor({ timeout: 12_000 });
    await searchInput.fill("Tartan");
    await plaidFrame.getByText(/tartan/i).first().click();
    await plaidFrame.getByLabel(/username/i).fill("user_good");
    await plaidFrame.getByLabel(/password/i).fill("pass_good");
    await plaidFrame.getByRole("button", { name: /continue|submit/i }).click();
    const mfa = plaidFrame.getByLabel(/code|mfa/i);
    if (await mfa.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await mfa.fill("1234");
      await plaidFrame.getByRole("button", { name: /continue|submit/i }).click();
    }
    await plaidFrame.getByRole("button", { name: /continue/i }).click({ timeout: 15_000 });
    const finishWithout = plaidFrame.getByRole("button", { name: /finish without saving/i });
    await finishWithout.waitFor({ timeout: 12_000 });
    await finishWithout.click();
    await expect(page.getByText(/tartan/i)).toBeVisible({ timeout: 25_000 });

    // Find workspace.
    const wsResp = await page.request.get(`${API}/workspaces`);
    const wsId = (await wsResp.json()).workspaces[0].id as string;

    // Poll until all sandbox transactions are categorized (auto-categorize is
    // a detached promise; needs a moment).
    let categorizedCount = 0;
    let totalCount = 0;
    for (let i = 0; i < 30; i++) {
      const txResp = await page.request.get(
        `${API}/workspaces/${wsId}/transactions?limit=200`,
        { headers: { "x-workspace-id": wsId } },
      );
      const txs = (await txResp.json()).transactions as Array<{ id: string; categoryId: string | null }>;
      totalCount = txs.length;
      categorizedCount = txs.filter((t) => t.categoryId !== null).length;
      if (totalCount > 0 && categorizedCount === totalCount) break;
      await page.waitForTimeout(2_000);
    }
    expect(totalCount).toBeGreaterThan(0);
    expect(categorizedCount).toBe(totalCount);

    // Pick a transaction and manually re-categorize it. Mapping back-fill
    // should affect other tx sharing the same normalized merchant.
    const txResp = await page.request.get(
      `${API}/workspaces/${wsId}/transactions?limit=200`,
      { headers: { "x-workspace-id": wsId } },
    );
    const txs = (await txResp.json()).transactions as Array<{
      id: string;
      merchantRaw: string;
      merchantNormalized: string | null;
      categoryId: string | null;
    }>;
    // Find a merchant that has at least 2 tx
    const groupByMerchant = new Map<string, typeof txs>();
    for (const t of txs) {
      const key = t.merchantNormalized ?? t.merchantRaw.toLowerCase();
      groupByMerchant.set(key, [...(groupByMerchant.get(key) ?? []), t]);
    }
    const [merchantKey, group] = [...groupByMerchant.entries()].find(([, g]) => g.length >= 2) ?? [];
    if (!merchantKey || !group) {
      test.skip(true, "Sandbox did not return a merchant with ≥2 tx; can't test back-fill");
      return;
    }
    const target = group[0]!;

    const recat = await page.request.post(
      `${API}/workspaces/${wsId}/transactions/${target.id}/categorize`,
      {
        headers: { "x-workspace-id": wsId, "content-type": "application/json" },
        data: { categoryName: "Other" },
      },
    );
    expect(recat.status()).toBe(200);
    const recatBody = await recat.json();
    expect(recatBody.transaction.categorizationSource).toBe("manual");
    expect(recatBody.backfilledCount).toBeGreaterThanOrEqual(group.length - 1);

    // Verify mapping was created
    const otherCat = await page.request.get(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId },
    });
    const otherId = (await otherCat.json()).categories.find((c: { name: string }) => c.name === "Other").id;
    // Manually check a sibling
    const siblingResp = await page.request.get(
      `${API}/workspaces/${wsId}/transactions?limit=200`,
      { headers: { "x-workspace-id": wsId } },
    );
    const sibling = ((await siblingResp.json()).transactions as typeof txs).find(
      (t) => t.id === group[1]!.id,
    )!;
    expect(sibling.categoryId).toBe(otherId);
  });

  test("categories CRUD", async ({ page }) => {
    const email = uniqueEmail("cat-crud");
    await signUp(page, email);
    const wsResp = await page.request.get(`${API}/workspaces`);
    const wsId = (await wsResp.json()).workspaces[0].id as string;

    // GET — seeded
    const list1 = await page.request.get(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId },
    });
    const names = (await list1.json()).categories.map((c: { name: string }) => c.name);
    expect(names).toContain("Groceries");
    expect(names).toContain("Income");

    // POST
    const post = await page.request.post(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { name: "Hobbies" },
    });
    expect(post.status()).toBe(201);

    // POST duplicate
    const dup = await page.request.post(`${API}/workspaces/${wsId}/categories`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { name: "hobbies" },
    });
    expect(dup.status()).toBe(422);
  });
});
```

- [ ] **Step 2: Run E2E (with real Gemini API key)**

```bash
export GEMINI_API_KEY=<real-key>
pnpm e2e -- --grep "categorize"
```

Expected: both tests pass when `PLAID_CLIENT_ID` + `PLAID_SECRET` + real `GEMINI_API_KEY` are set; otherwise SKIPped.

- [ ] **Step 3: Full E2E suite still passes**

```bash
pnpm e2e
```

Expected: 13 prior tests + 2 new = 15/15 (or skip the new 2 if no Gemini key).

- [ ] **Step 4: NO COMMIT.**

---

## Task 14: Final verification + README + smoke-test doc

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/smoke-tests/2026-05-12-plan-1b-categorize.md`

- [ ] **Step 1: Full test + typecheck + lint sweep**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run-many -t test
pnpm nx run-many -t typecheck
pnpm nx run-many -t lint
```

Expected: 196 API tests green; typecheck green for all 4 projects; lint 0 errors.

- [ ] **Step 2: Create `docs/superpowers/smoke-tests/2026-05-12-plan-1b-categorize.md`**

```markdown
# Plan 1B-categorize Smoke Test

**Prerequisites:** API + web running, `PLAID_*` env set, `ENCRYPTION_KEY` set, **`GEMINI_API_KEY` set** to a real Gemini API key (get one at https://aistudio.google.com/app/apikey).

## 1. Sign up + connect Plaid

Follow the Plan 1B-foundation smoke test through the "Connect → see transactions" section. End state: bank connected, ~15 transactions in DB.

## 2. Verify auto-categorize

In Prisma Studio (`pnpm smoke:db:studio`) or via psql:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c "
SELECT t."merchantRaw", t."merchantNormalized", c.name AS category, t."categorizationSource"
FROM transactions t
LEFT JOIN categories c ON c.id = t."categoryId"
ORDER BY t."occurredAt" DESC LIMIT 20;
"
```

Expected: each transaction has `category` populated and `categorizationSource` is `mapping` or `ai`. Most should be `ai` on first run (no mappings yet).

## 3. Test manual categorize + back-fill

Get a tx ID and recategorize:

```bash
TX_ID=<paste a tx id>
WS_ID=<paste your workspace id>
SESSION=<paste your session cookie>

curl -X POST "http://localhost:4000/workspaces/$WS_ID/transactions/$TX_ID/categorize" \
  -H "x-workspace-id: $WS_ID" \
  -H "content-type: application/json" \
  --cookie "$SESSION" \
  -d '{"categoryName": "Dining"}'
```

Expected response: `{transaction: {…, categorizationSource: "manual"}, backfilledCount: <N>}` where N is the number of sibling transactions.

Re-query the DB and confirm:
- The target tx now has source `manual`.
- Sibling tx with the same `merchantNormalized` now have source `mapping`.
- A `merchant_mappings` row appears with `source = manual`.

## 4. Free-tier check

categorize itself is not Pro-gated (any editor+ can categorize). The Pro gate stays on Plaid connect/refresh.
```

- [ ] **Step 3: Update README Status block**

Find the Plan 1B-foundation Status line and add below it:

```markdown
- ✅ Plan 1B-categorize complete: auto transaction categorization (backend) — merchant_mappings table + categorizationSource enum, 11 English category seed (case-insensitive partial unique), loop-until-stable merchant normalizer, Gemini 2.5 Flash Lite via @google/genai with structured JSON output, mapping-first + LLM-fallback service with manual-vs-AI race protection, syncTransactions returns newTxIds (exchange route detached, manual sync awaited), categories CRUD + manual categorize routes with back-fill. **API: 196 tests passing.**
```

And update the "Next options" line to note 1B-categorize is done.

- [ ] **Step 4: NO COMMIT.** User reviews and commits the entire plan implementation as one feat commit.

---

## Done — Plan 1B-categorize Exit Criteria

- [ ] `pnpm nx run-many -t test` green: ~196 API tests.
- [ ] `pnpm nx run-many -t typecheck` green for all 4 projects.
- [ ] `pnpm nx run-many -t lint` green.
- [ ] **Smoke:** Pro user → Plaid sandbox connect → all auto-imported tx have `categoryId` set; manual recategorize → mapping created + siblings back-filled.
- [ ] **Failure modes covered by tests:** Gemini API down, invalid category response, unknown tx_id, batch > max, manual race, archived category, workspace-scoped resolution.
- [ ] **Cost ceiling:** No more than ~$0.0003 per sync at 15 tx; per-call batch capped at `CATEGORIZE_BATCH_MAX = 50`.
- [ ] **No leakage between workspaces:** `merchant_mappings` and category lookups always scoped by `workspaceId` (tested).
