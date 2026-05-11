# Plan 1B-foundation — Plaid Integration (Web) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pro-tier user on web clicks "Connect a bank", completes the Plaid Link **sandbox** flow, and ends up with `plaid_items` + `bank_accounts` + `transactions` rows in the DB. Manual "Refresh" re-runs `/transactions/sync` from the stored cursor; "Disconnect" removes the item but keeps transactions for history. Free-tier users see an upgrade prompt instead of Connect.

**Architecture:** Backend grows four Prisma models (`PlaidItem`, `BankAccount`, `Transaction`, `Category` — last is empty), an AES-256-GCM encryption layer for `access_token` at rest with `workspaceId` as AAD, a `requireProTier` helper, a per-item Postgres row lock (`SELECT ... FOR UPDATE NOWAIT`) around the `transactionsSync` page tx, and seven endpoints all under `/workspaces/:id/...`. The Plaid model is named `BankAccount` (not `Account`) to avoid colliding with Better Auth's `Account` table. Sync uses a per-page-tx + status-persist-tx structure so error/relink_required state survives Plaid failures, with `lastCursor` / `lastSyncAt` advanced ONLY after `has_more === false` so partial failures re-fetch idempotently from the original cursor. Mutation-during-pagination is detected via the Plaid error code `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` and restarts the page loop from the original cursor. Web ships a single `/settings/banks` page with `react-plaid-link` for the Connect flow. Mobile is unchanged.

**Tech Stack:** Prisma 5 + Postgres 16 (existing), Fastify 5 + Better Auth 1.6 (existing), `plaid` Node SDK 42, `react-plaid-link` 4 (web), vitest 2.

---

## Spec context

This plan implements `docs/superpowers/specs/2026-05-11-plan-1b-plaid-foundation-design.md` end-to-end. Master spec relevant: `docs/superpowers/specs/2026-05-07-fina-design.md` §8 (data model), §9 (Plaid sync model), §10 (authz hard rules), §15 Phase 1B.

**Frozen design decisions** (no arguing about during execution — see spec for rationale):

- **Web only.** No mobile UI in this plan. No webhook handler. No cron. No LLM categorize. (See spec §11 for follow-ups.)
- **Sandbox env.** `PLAID_ENV=sandbox`. Code accepts the env var so future promotion to development/production is one config change.
- **Pro tier only.** No Lite-1-Item logic until billing/`subscriptions` exists. `requireProTier` rejects with `402 upgrade_required`.
- **All Plaid-mutating routes are owner-only.** Pro check fires on the **requesting** user for `link-token`, `exchange`, `sync`. Reads are members-only with no tier gate. **Disconnect (`DELETE /plaid-items/:itemId`) is the deliberate exception:** owner-only but NOT Pro-gated, so a user whose trial expired can still revoke Plaid's access to their bank rather than being trapped by the paywall.
- **AES-256-GCM at rest.** `accessTokenCiphertext` (Bytes, 16-byte tag appended) + `accessTokenIv` (12 Bytes). AAD = `workspaceId`. Key from `ENCRYPTION_KEY` env (base64 32 bytes).
- **Cursor-based sync per spec §9.2.** Per-page commit. Per-item row-level lock via `SELECT ... FOR UPDATE NOWAIT` on `plaid_items` inside each page-tx (originally drafted as `pg_try_advisory_xact_lock`, but that lock releases at commit and would let two concurrent refreshes both read the same cursor — caught in plan review). `lastCursor`+`lastSyncAt` only commit on `has_more=false`. Mutation-during-pagination → restart from `originalCursor`. Status writes happen in a separate transaction so they survive failures.
- **Pending → posted promotion lookup key:** `plaidTransactionId == t.pending_transaction_id` (NOT `plaidPendingTransactionId`). Promotion clears `removedAt: null` if the pending row was already soft-removed in an earlier page.
- **Disconnect is strict.** Plaid `/item/remove` MUST succeed (or return ITEM_NOT_FOUND) before the local row is deleted. Same row-level lock as sync (it acquires `FOR UPDATE NOWAIT` before the Plaid call, returns 409 `sync_in_progress` if held).
- **Initial sync inside `/exchange` is split-tx.** Item + accounts commit first; sync runs separately; on sync failure the response is still 200 with `syncOk: false` and the item is durable.
- **Endpoint shape: `/workspaces/:id/plaid/...`** to match Plan 2 conventions, with header/path mismatch guard.

---

## File structure

### Backend (`apps/api`) — most of this plan

| File | Status | Responsibility |
|---|---|---|
| `prisma/schema.prisma` | modify | add 4 models (`PlaidItem`, `BankAccount` — name avoids the Better Auth `Account` collision, `Transaction`, `Category`) + 3 enums (`PlaidItemStatus`, `AccountStatus`, `TransactionSource`) + Workspace relations |
| `prisma/migrations/<ts>_add_plaid/migration.sql` | new | generated migration with 2 partial indexes appended manually |
| `src/env.ts` | modify | add `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `ENCRYPTION_KEY` |
| `src/crypto/aes-gcm.ts` | new | `encrypt(env, plaintext, aad)` / `decrypt(env, ciphertext, iv, aad)` — pure Node `crypto` |
| `src/auth/tier.ts` | new | `effectiveTier(userId)`, `requireProTier(userId)` — Pro from trial only in this plan |
| `src/routes/me.ts` | modify | drop inline `effectiveTier`; import from `auth/tier.ts` |
| `src/plaid/client.ts` | new | `plaidClient(env)` + `PLAID_PRODUCTS` + `PLAID_COUNTRY_CODES` + `sanitizePlaidError(e)` + `isPlaidErrorCode(e, code)` |
| `src/plaid/lock.ts` | new | `lockPlaidItem(tx, plaidItemId)` (`SELECT ... FOR UPDATE NOWAIT`) + `SyncLockHeld` — shared by `items.ts` (disconnect) and `sync.ts` (per-page tx) so neither imports the other for locking |
| `src/plaid/items.ts` | new | service: `storeAccessToken(env, tx, {workspaceId, itemId, institutionId, institutionName, accessToken})` (caller wraps in `prisma.$transaction`), `readAccessToken(env, wsId, plaidItemId)` (verifies pair), `removeItemStrict(env, wsId, plaidItemId)` (Plaid call inside an outer tx that takes `lockPlaidItem` first; surfaces 409 `sync_in_progress` on contention) |
| `src/plaid/sync.ts` | new | `syncTransactions(env, wsId, plaidItemId)` — read-then-loop with per-page-tx (`lockPlaidItem`) + final-tx + status-persist-tx; `upsertAdded`, `upsertModified`, `markRemoved`, `plaidOccurredAt`, `plaidPostedAt` |
| `src/routes/plaid.ts` | new | `POST /workspaces/:id/plaid/link-token`, `POST /workspaces/:id/plaid/exchange` (with `syncOk` partial-failure contract) |
| `src/routes/plaid-items.ts` | new | `GET /workspaces/:id/plaid-items`, `POST /workspaces/:id/plaid-items/:itemId/sync`, `DELETE /workspaces/:id/plaid-items/:itemId` |
| `src/routes/accounts.ts` | new | `GET /workspaces/:id/accounts` |
| `src/routes/transactions.ts` | new | `GET /workspaces/:id/transactions` (cursor-paginated) |
| `src/server.ts` | modify | register four new route plugins |
| `tests/helpers/db.ts` | modify | extend TRUNCATE with new tables |
| `tests/helpers/plaid-mock.ts` | new | scriptable Plaid mock for vitest (`vi.mock('plaid', ...)` factory) |
| `tests/plaid.crypto.test.ts` | new | AES-GCM round-trip, AAD mismatch, key length |
| `tests/plaid.tier.test.ts` | new | `requireProTier` cases |
| `tests/plaid.sync.test.ts` | new | service-level sync edge cases |
| `tests/plaid.exchange.test.ts` | new | exchange route + initial sync partial-failure |
| `tests/plaid.routes.test.ts` | new | route-level: list/sync/disconnect/accounts/transactions, auth+role+Pro |
| `tests/me.test.ts` | modify | tier comes from new helper now (no behavior change, just import) |
| `apps/api/.env.test` | modify | add deterministic `PLAID_*` + `ENCRYPTION_KEY` (test-only fixed values) |
| `apps/api/package.json` | modify | add `plaid@^42` dep |

### Web (`apps/web`)

| File | Status | Responsibility |
|---|---|---|
| `package.json` | modify | add `react-plaid-link@^4` |
| `src/app/(app)/settings/banks/page.tsx` | new | data fetch + render two sub-components |
| `src/app/(app)/settings/banks/_components/connect-bank-button.tsx` | new | `usePlaidLink` integration; Pro-gated UI |
| `src/app/(app)/settings/banks/_components/connected-banks-list.tsx` | new | per-item Refresh / Disconnect actions |
| `src/app/(app)/layout.tsx` | modify | add `Banks` link to header nav |

### Docs / repo

| File | Status | Responsibility |
|---|---|---|
| `.env.example` | modify | document new env vars |
| `docs/superpowers/smoke-tests/2026-05-08-plan-2-workspace-sharing.md` | modify | append Plaid sandbox section |
| `package.json` | modify | smoke scripts pass through `PLAID_*` + `ENCRYPTION_KEY` |
| `README.md` | modify | bump Status block |

---

## Conventions

- **Imports:** TS source uses `.js` extension on relative imports (matches existing ESM build).
- **Error mapping:** centralize per-resource (existing pattern: `mapInviteError`, `mapMembersError`). New `mapPlaidError(e)` lives in `src/plaid/client.ts`.
- **Test env literal:** every server test reuses the same shape with `WEB_APP_URL` (Plan 2) plus `PLAID_*` + `ENCRYPTION_KEY` (this plan). Helper to come in Task 2.
- **Vitest pool:** existing `singleFork: true` is preserved — Plaid mock state is process-local.
- **Commits:** one per task at the end (`feat(api):` for new behavior, `feat(web):` for web, `refactor(api):` for `/me` tier consolidation).
- **Currency / amount:** Plaid amounts are floats (USD/CAD with 2 decimals). We store as Postgres `Decimal(14, 2)`. Tests use exact-decimal helpers.

---

## Task 1: Schema — 4 Plaid models + relations + 2 partial indexes + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_add_plaid/migration.sql` (generated; manually appended)
- Modify: `apps/api/tests/helpers/db.ts`

- [ ] **Step 1: Add Workspace relation fields**

In `apps/api/prisma/schema.prisma`, locate the `Workspace` model. Add these four lines inside the relations block (alongside `memberships Membership[]` and `invites Invite[]`):

```prisma
  plaidItems    PlaidItem[]
  bankAccounts  BankAccount[]
  transactions  Transaction[]
  categories    Category[]
```

- [ ] **Step 2: Append the four Plaid models + enums at the end of the file**

After the `enum InviteStatus { ... }` block, append:

```prisma
model PlaidItem {
  id                       String          @id @default(cuid())
  workspaceId              String
  // AES-256-GCM. AAD = workspaceId so a row swapped between workspaces won't decrypt.
  // Layout: ciphertext bytes followed by 16-byte auth tag.
  accessTokenCiphertext    Bytes
  accessTokenIv            Bytes           // 12 bytes
  itemId                   String          @unique  // Plaid item_id; second exchange retry hits P2002
  institutionId            String
  institutionName          String
  status                   PlaidItemStatus @default(active)
  errorCode                String?
  lastSyncAt               DateTime?
  lastCursor               String?
  createdAt                DateTime        @default(now())
  updatedAt                DateTime        @updatedAt

  workspace                Workspace       @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  bankAccounts             BankAccount[]
  transactions             Transaction[]

  @@index([workspaceId])
  @@map("plaid_items")
}

enum PlaidItemStatus {
  active
  error
  relink_required
}

model BankAccount {
  id                  String        @id @default(cuid())
  workspaceId         String
  plaidItemId         String?
  plaidAccountId      String?       @unique
  name                String
  officialName        String?
  mask                String?
  type                String
  subtype             String?
  currency            String        @default("CAD")
  status              AccountStatus @default(active)
  balanceCurrent      Decimal?      @db.Decimal(14, 2)
  balanceAvailable    Decimal?      @db.Decimal(14, 2)
  balanceLimit        Decimal?      @db.Decimal(14, 2)
  lastBalanceSyncAt   DateTime?
  archivedAt          DateTime?
  createdAt           DateTime      @default(now())

  workspace           Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  // SetNull (NOT Cascade) — disconnect must keep accounts (and via them, transactions)
  // as history. Disconnect handler also stamps archivedAt so UI can hide them.
  plaidItem           PlaidItem?    @relation(fields: [plaidItemId], references: [id], onDelete: SetNull)
  transactions        Transaction[]

  @@index([workspaceId, plaidItemId])
  @@map("bank_accounts")
}

enum AccountStatus {
  active
  closed
  hidden
}

model Transaction {
  id                          String             @id @default(cuid())
  workspaceId                 String
  accountId                   String
  plaidItemId                 String?
  plaidTransactionId          String?
  plaidPendingTransactionId   String?
  amount                      Decimal            @db.Decimal(14, 2)
  currency                    String             @default("CAD")
  merchantRaw                 String
  merchantNormalized          String?
  categoryId                  String?
  occurredAt                  DateTime
  postedAt                    DateTime?
  pending                     Boolean            @default(false)
  source                      TransactionSource  @default(plaid)
  rawData                     Json
  note                        String?
  removedAt                   DateTime?
  createdAt                   DateTime           @default(now())
  updatedAt                   DateTime           @updatedAt

  workspace                   Workspace          @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  // FK column kept as `accountId` (not `bankAccountId`) so URL/query filters
  // and prior plan-2 code that exposes accountId in API responses don't churn.
  // The Prisma model is BankAccount but the field name is unchanged.
  account                     BankAccount        @relation(fields: [accountId], references: [id], onDelete: Cascade)
  plaidItem                   PlaidItem?         @relation(fields: [plaidItemId], references: [id], onDelete: SetNull)
  category                    Category?          @relation(fields: [categoryId], references: [id], onDelete: SetNull)

  @@index([workspaceId, occurredAt(sort: Desc)])
  @@index([workspaceId, accountId, occurredAt(sort: Desc)])
  @@index([workspaceId, categoryId])
  @@map("transactions")
}

enum TransactionSource {
  plaid
  manual
  csv
}

model Category {
  id          String        @id @default(cuid())
  workspaceId String
  name        String
  parentId    String?
  icon        String?
  color       String?
  archivedAt  DateTime?
  createdAt   DateTime      @default(now())

  workspace    Workspace    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  parent       Category?    @relation("CategoryTree", fields: [parentId], references: [id])
  children     Category[]   @relation("CategoryTree")
  transactions Transaction[]

  @@unique([workspaceId, name])
  @@map("categories")
}
```

- [ ] **Step 3: Generate the migration without applying**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_plaid
```

`--create-only` writes SQL under `apps/api/prisma/migrations/<ts>_add_plaid/migration.sql` without applying — we need to append the partial indexes first.

- [ ] **Step 4: Append the two partial indexes to the generated migration.sql**

Open `apps/api/prisma/migrations/<ts>_add_plaid/migration.sql`. At the very end, append:

```sql
-- Partial indexes — Prisma can't model these in schema.prisma.
-- 1) UNIQUE: dedupe Plaid transactions per workspace; manual transactions
--    have NULL plaidTransactionId so a single full UNIQUE doesn't work.
-- 2) Non-unique: support the categorize plan's "uncategorized list" daily
--    UX query without forcing a future migration.
CREATE UNIQUE INDEX "transactions_one_per_plaid_id_per_workspace"
  ON "transactions" ("workspaceId", "plaidTransactionId")
  WHERE "plaidTransactionId" IS NOT NULL;

CREATE INDEX "transactions_uncategorized"
  ON "transactions" ("workspaceId", "occurredAt" DESC)
  WHERE "categoryId" IS NULL AND "removedAt" IS NULL;
```

- [ ] **Step 5: Apply the migration**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:migrate
```

Expected: "Your database is now in sync with your schema." Then sanity-check the partial indexes exist:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c "\d transactions" | grep -E 'one_per_plaid|uncategorized'
```

Both index names should print.

Also run for the test DB:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api db:deploy
```

- [ ] **Step 6: Update test TRUNCATE list**

Edit `apps/api/tests/helpers/db.ts` to include the new tables (leaf-to-root order):

> **NOTE:** the Plaid model used to be called `Account` (mapped to `accounts`), which collided with Better Auth's existing `accounts` table — caught in spec review and resolved by renaming Plaid's model to `BankAccount` mapped to `bank_accounts`. Even with that rename, the cleanest TRUNCATE is to lean on cascade rather than enumerate every table, so the next-write block stays small and survives future schema growth.

```ts
import { prisma } from "../../src/db.js";

export async function truncateAll(): Promise<void> {
  // Workspace cascade kills plaid_items, bank_accounts (Plaid), transactions,
  // categories, invites, memberships. User cascade kills sessions, accounts
  // (better-auth), verifications, memberships. Order: workspaces first (so
  // workspace-scoped rows are removed cleanly), then users.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "workspaces" RESTART IDENTITY CASCADE;`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "verifications" RESTART IDENTITY CASCADE;`);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
```

This avoids any future name-collision risk and is more maintainable as the schema grows.

- [ ] **Step 7: Verify existing tests still pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 82 tests still PASS (no behavior change in this task — schema only).

- [ ] **Step 8: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/tests/helpers/db.ts
git commit -m "feat(api): add Plaid schema (PlaidItem/BankAccount/Transaction/Category) + partial indexes"
```

---

## Task 2: Env vars (PLAID_*, ENCRYPTION_KEY) + .env.test + smoke scripts

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/.env.test`
- Modify: `.env.example`
- Modify: `package.json` (smoke scripts)

- [ ] **Step 1: Add the env fields to the zod schema**

Edit `apps/api/src/env.ts`. After the existing `WEB_APP_URL` line:

```ts
  // Plaid
  PLAID_CLIENT_ID: z.string(),
  PLAID_SECRET: z.string(),
  PLAID_ENV: z.enum(["sandbox", "development", "production"]).default("sandbox"),
  // Soft deadline for the initial sync inside POST /plaid/exchange. Tests
  // override to a small value so the timeout path is exercised with real
  // timers (vi.useFakeTimers + fastify.inject is racy and brittle).
  PLAID_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // AES-256-GCM key for at-rest encryption (Plaid access_token).
  // Must base64-decode to exactly 32 bytes. Validation happens lazily inside
  // the crypto helper so tests can use a fixed value without re-running zod.
  ENCRYPTION_KEY: z.string(),
```

- [ ] **Step 2: Add to `apps/api/.env.test`**

Append (deterministic test values; Plaid SDK is mocked, so client_id/secret can be any non-empty strings; ENCRYPTION_KEY is a deterministic base64 of 32 bytes for repeatable tests):

```
PLAID_CLIENT_ID=test_client_id
PLAID_SECRET=test_secret
PLAID_ENV=sandbox
ENCRYPTION_KEY=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=
```

The base64 above decodes to 32 bytes `[0x00, 0x01, ..., 0x1F]` — readable in failure messages.

- [ ] **Step 3: Update `.env.example` (root)**

In the repo-root `.env.example`, add a new section before "Mobile":

```
# Plaid (sandbox to start; promote PLAID_ENV later for development/production)
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox

# AES-256-GCM key for Plaid access_token at rest.
# Generate with:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEY=
```

- [ ] **Step 4: Pass-through Plaid env in smoke scripts**

Edit `package.json`. Update the two `smoke:api*` scripts (`smoke:api` and `smoke:api:lan`) so they pass through any `PLAID_*` and `ENCRYPTION_KEY` already in the user's shell, instead of dropping them. Replace them with:

```json
    "smoke:api": "RESEND_API_KEY= DATABASE_URL=postgresql://fina:fina@localhost:5433/fina WEB_APP_URL=http://localhost:3100 nx run api:dev",
    "smoke:api:lan": "RESEND_API_KEY= DATABASE_URL=postgresql://fina:fina@localhost:5433/fina WEB_APP_URL=http://100.65.93.102:3100 BETTER_AUTH_URL=http://100.65.93.102:4000 DEV_ORIGINS=http://100.65.93.102:3100 nx run api:dev",
```

(They already pass through any shell env that's not explicitly set inline. The `PLAID_*` and `ENCRYPTION_KEY` vars need to come from the user's shell — they can `export` them in their `.env` or `.zshrc`. We document this in the smoke-test doc in Task 14. No change to the script body; the shell env inheritance is already correct. This step is a no-op for code but a checkpoint for the engineer to **read the user's `.env` and confirm the four new keys exist before moving on**.)

If the user hasn't filled in their `.env` yet, prompt them to do so (the dev API will refuse to start without `PLAID_CLIENT_ID`, `PLAID_SECRET`, `ENCRYPTION_KEY`).

- [ ] **Step 5: Update legacy test env literals**

Tests in this plan and prior plans pass an `Env`-typed literal to `buildApp(env)`. The new required fields will break TypeScript on those literals. Add `PLAID_CLIENT_ID: "test_client_id", PLAID_SECRET: "test_secret", PLAID_ENV: "sandbox" as const, ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",` to the env block in each:

- `apps/api/tests/auth.context.test.ts`
- `apps/api/tests/auth.session.test.ts`
- `apps/api/tests/health.test.ts`
- `apps/api/tests/invites.routes.test.ts`
- `apps/api/tests/invites.service.test.ts`
- `apps/api/tests/me.test.ts`
- `apps/api/tests/members.routes.test.ts`
- `apps/api/tests/members.service.test.ts`
- `apps/api/tests/membership.test.ts`
- `apps/api/tests/workspaces.bootstrap.test.ts`
- `apps/api/tests/workspaces.test.ts`

Tip: do this with a single `sed` pass. The `WEB_APP_URL: "http://localhost:3000",` line is unique enough to anchor on:

```bash
cd /home/cwsbr/personal/fina/apps/api/tests
for f in auth.context.test.ts auth.session.test.ts health.test.ts \
         invites.routes.test.ts invites.service.test.ts me.test.ts \
         members.routes.test.ts members.service.test.ts membership.test.ts \
         workspaces.bootstrap.test.ts workspaces.test.ts; do
  sed -i 's|WEB_APP_URL: "http://localhost:3000",|WEB_APP_URL: "http://localhost:3000",\n  PLAID_CLIENT_ID: "test_client_id",\n  PLAID_SECRET: "test_secret",\n  PLAID_ENV: "sandbox" as const,\n  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",|' "$f"
done
```

- [ ] **Step 6: Verify**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
pnpm nx run api:typecheck
```

Both green; 82/82 tests still pass.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/env.ts apps/api/.env.test .env.example package.json apps/api/tests/*.test.ts
git commit -m "feat(api): PLAID_* + ENCRYPTION_KEY env vars; patch test literals"
```

---

## Task 3: AES-GCM crypto helper + tests

**Files:**
- Create: `apps/api/src/crypto/aes-gcm.ts`
- Create: `apps/api/tests/plaid.crypto.test.ts`

- [ ] **Step 1: Write failing test**

Create `apps/api/tests/plaid.crypto.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { encrypt, decrypt } from "../src/crypto/aes-gcm.js";

const env = { ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=" };

describe("aes-gcm", () => {
  it("round-trips plaintext with AAD", () => {
    const { ciphertext, iv } = encrypt(env, "access-secret", "ws_abc");
    expect(iv.length).toBe(12);
    expect(ciphertext.length).toBeGreaterThan(16); // includes 16-byte auth tag
    const out = decrypt(env, ciphertext, iv, "ws_abc");
    expect(out).toBe("access-secret");
  });

  it("decryption fails when AAD differs", () => {
    const { ciphertext, iv } = encrypt(env, "access-secret", "ws_abc");
    expect(() => decrypt(env, ciphertext, iv, "ws_other")).toThrow();
  });

  it("decryption fails when ciphertext is tampered", () => {
    const { ciphertext, iv } = encrypt(env, "access-secret", "ws_abc");
    ciphertext[0] = ciphertext[0] ^ 0xff;
    expect(() => decrypt(env, ciphertext, iv, "ws_abc")).toThrow();
  });

  it("uses a fresh IV each call (no IV reuse)", () => {
    const a = encrypt(env, "x", "ws");
    const b = encrypt(env, "x", "ws");
    expect(a.iv.equals(b.iv)).toBe(false);
    // Different IV → different ciphertext for same plaintext + key + AAD.
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("key length must decode to exactly 32 bytes", () => {
    const tooShort = { ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") };
    expect(() => encrypt(tooShort, "x", "ws")).toThrow(/32 bytes/);
    const tooLong = { ENCRYPTION_KEY: Buffer.alloc(48).toString("base64") };
    expect(() => encrypt(tooLong, "x", "ws")).toThrow(/32 bytes/);
  });

  it("ciphertext is independent of the helper that wrote it (sanity vs raw decipher)", () => {
    const plaintext = "abc";
    const aad = "ws";
    const { ciphertext, iv } = encrypt(env, plaintext, aad);

    const key = Buffer.from(env.ENCRYPTION_KEY, "base64");
    const tag = ciphertext.subarray(ciphertext.length - 16);
    const enc = ciphertext.subarray(0, ciphertext.length - 16);
    const dec = crypto.createDecipheriv("aes-256-gcm", key, iv);
    dec.setAAD(Buffer.from(aad, "utf8"));
    dec.setAuthTag(tag);
    expect(Buffer.concat([dec.update(enc), dec.final()]).toString("utf8")).toBe(plaintext);
  });
});
```

- [ ] **Step 2: Run (expect fail — module missing)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.crypto.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `apps/api/src/crypto/aes-gcm.ts`**

```ts
import crypto from "node:crypto";

const ALG = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
let cachedKeyForBase64: string | null = null;

function getKey(env: { ENCRYPTION_KEY: string }): Buffer {
  if (cachedKey && cachedKeyForBase64 === env.ENCRYPTION_KEY) return cachedKey;
  const buf = Buffer.from(env.ENCRYPTION_KEY, "base64");
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `ENCRYPTION_KEY must be base64 of exactly ${KEY_LEN} bytes (got ${buf.length})`,
    );
  }
  cachedKey = buf;
  cachedKeyForBase64 = env.ENCRYPTION_KEY;
  return buf;
}

export function encrypt(
  env: { ENCRYPTION_KEY: string },
  plaintext: string,
  aad: string,
): { ciphertext: Buffer; iv: Buffer } {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(env), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext: Buffer.concat([enc, cipher.getAuthTag()]), iv };
}

export function decrypt(
  env: { ENCRYPTION_KEY: string },
  ciphertext: Buffer,
  iv: Buffer,
  aad: string,
): string {
  if (ciphertext.length < TAG_LEN) {
    throw new Error("ciphertext too short to contain auth tag");
  }
  const tag = ciphertext.subarray(ciphertext.length - TAG_LEN);
  const enc = ciphertext.subarray(0, ciphertext.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALG, getKey(env), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.crypto.test.ts
```

Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/crypto/aes-gcm.ts apps/api/tests/plaid.crypto.test.ts
git commit -m "feat(api): AES-256-GCM crypto helper with AAD"
```

---

## Task 4: Tier helper (`requireProTier` + `effectiveTier`) + `/me` refactor

**Files:**
- Create: `apps/api/src/auth/tier.ts`
- Modify: `apps/api/src/routes/me.ts`
- Create: `apps/api/tests/plaid.tier.test.ts`

- [ ] **Step 1: Write failing test for the helper**

Create `apps/api/tests/plaid.tier.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { effectiveTier, requireProTier } from "../src/auth/tier.js";
import { HttpError } from "../src/auth/context.js";

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
};

// File-level lifecycle (Plan 2 convention).
beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnect();
});

describe("requireProTier / effectiveTier", () => {
  it("returns pro + trialActive=true on a fresh trial signup", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "pro@x.com", name: "Pro" });
    const t = await effectiveTier(u.userId);
    expect(t.tier).toBe("pro");
    expect(t.trialActive).toBe(true);
    expect(t.source).toBe("trial");
    await app.close();
  });

  it("returns free after trial expires", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "exp@x.com", name: "Exp" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const t = await effectiveTier(u.userId);
    expect(t.tier).toBe("free");
    expect(t.trialActive).toBe(false);
    expect(t.source).toBe("default");
    await app.close();
  });

  it("requireProTier passes for trial-active user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "pro2@x.com", name: "Pro2" });
    await expect(requireProTier(u.userId)).resolves.toBeUndefined();
    await app.close();
  });

  it("requireProTier throws 402 upgrade_required for free user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "free@x.com", name: "Free" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    await expect(requireProTier(u.userId)).rejects.toMatchObject({
      statusCode: 402,
      code: "upgrade_required",
    });
    expect((await requireProTier(u.userId).catch((e) => e)) as HttpError).toBeInstanceOf(HttpError);
    await app.close();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.tier.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `apps/api/src/auth/tier.ts`**

```ts
import type { EffectiveTier } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError } from "./context.js";

export async function effectiveTier(userId: string): Promise<EffectiveTier> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.trialEndsAt && user.trialEndsAt > new Date()) {
    return {
      tier: "pro",
      source: "trial",
      trialActive: true,
      trialEndsAt: user.trialEndsAt,
    };
  }
  // Future: check active subscriptions for paid Pro/Lite — not in this plan.
  return {
    tier: "free",
    source: "default",
    trialActive: false,
    trialEndsAt: user.trialEndsAt,
  };
}

export async function requireProTier(userId: string): Promise<void> {
  const t = await effectiveTier(userId);
  if (t.tier !== "pro") {
    throw new HttpError(402, "upgrade_required", `Pro tier required (current: ${t.tier})`);
  }
}
```

- [ ] **Step 4: Refactor `apps/api/src/routes/me.ts` to use the new helper**

Replace the file with:

```ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      if (!user) return reply.code(404).send({ error: "no_user" });
      const t = await effectiveTier(user.id);
      return {
        user: { id: user.id, email: user.email, tz: user.tz, locale: user.locale },
        tier: t.tier,
        trial: { active: t.trialActive, endsAt: t.trialEndsAt?.toISOString() ?? null },
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 5: Run tier + me tests (expect pass)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.tier.test.ts tests/me.test.ts
```

Expected: 4 new tier tests + 3 existing me tests all PASS.

- [ ] **Step 6: Run full suite**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 92/92 (82 prior from Plan 2 + 6 from Task 3 crypto + 4 new tier tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/auth/tier.ts apps/api/src/routes/me.ts apps/api/tests/plaid.tier.test.ts
git commit -m "refactor(api): centralize effectiveTier + add requireProTier (402)"
```

---

## Task 5: Plaid client wrapper + error sanitization + test mock

**Files:**
- Modify: `apps/api/package.json` (add `plaid@^42`)
- Create: `apps/api/src/plaid/client.ts`
- Create: `apps/api/tests/helpers/plaid-mock.ts`

- [ ] **Step 1: Add Plaid SDK dependency**

```bash
pnpm --filter @fina/api add plaid@^42
```

Verify it's in `apps/api/package.json` under `dependencies`.

- [ ] **Step 2: Implement `apps/api/src/plaid/client.ts`**

```ts
import { Configuration, PlaidApi, PlaidEnvironments, type Products, type CountryCode } from "plaid";
import type { Env } from "../env.js";
import { HttpError } from "../auth/context.js";

let cached: PlaidApi | null = null;
let cachedFor: string | null = null;

export function plaidClient(env: Env): PlaidApi {
  // Cache key includes the SECRET as well — otherwise a test that flips
  // PLAID_SECRET while keeping client id + env constant would silently reuse
  // a client configured with the old secret.
  const cacheKey = `${env.PLAID_ENV}|${env.PLAID_CLIENT_ID}|${env.PLAID_SECRET}`;
  if (cached && cachedFor === cacheKey) return cached;
  cached = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env.PLAID_ENV],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID,
          "PLAID-SECRET": env.PLAID_SECRET,
          "Plaid-Version": "2020-09-14",
        },
      },
    }),
  );
  cachedFor = cacheKey;
  return cached;
}

export const PLAID_PRODUCTS: Products[] = ["transactions" as Products];
export const PLAID_COUNTRY_CODES: CountryCode[] = ["CA" as CountryCode];

/**
 * Plaid SDK errors (axios-shaped) include the request body in `error.config.data`,
 * which contains the access_token. Strip everything except the safe allowlist
 * before logging or returning to the client.
 */
export function sanitizePlaidError(e: unknown): {
  error_code: string | null;
  error_type: string | null;
  error_message: string | null;
  request_id: string | null;
  http_status: number | null;
} {
  const any = e as Record<string, unknown>;
  const data = (any?.response as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const status = (any?.response as Record<string, unknown> | undefined)?.status as number | undefined;
  return {
    error_code: (data?.error_code as string) ?? null,
    error_type: (data?.error_type as string) ?? null,
    error_message: (data?.error_message as string) ?? null,
    request_id: (data?.request_id as string) ?? null,
    http_status: status ?? null,
  };
}

export function isPlaidErrorCode(e: unknown, code: string): boolean {
  return sanitizePlaidError(e).error_code === code;
}

export function isPlaidApiError(e: unknown): boolean {
  return sanitizePlaidError(e).error_code !== null;
}

/** Map a Plaid error to our HttpError taxonomy. Always sanitized. */
export function mapPlaidError(e: unknown): HttpError {
  const s = sanitizePlaidError(e);
  switch (s.error_code) {
    case "ITEM_LOGIN_REQUIRED":
    case "ITEM_LOCKED":
    case "INVALID_CREDENTIALS":
      return new HttpError(409, "plaid_login_required", s.error_message ?? "");
    case "INVALID_PUBLIC_TOKEN":
    case "INVALID_REQUEST":
      return new HttpError(410, "plaid_link_expired", s.error_message ?? "");
    case "ITEM_NOT_FOUND":
      // Caller usually treats this as success on disconnect path; only mapped here
      // if it leaks to a route handler unexpectedly.
      return new HttpError(404, "plaid_item_not_found", s.error_message ?? "");
    default:
      return new HttpError(502, "plaid_unavailable", s.error_message ?? "Plaid request failed");
  }
}
```

- [ ] **Step 3: Implement test mock**

Create `apps/api/tests/helpers/plaid-mock.ts`:

```ts
import { vi } from "vitest";

/**
 * Scriptable Plaid mock for vitest. Tests configure a queue of responses
 * per method; the mock pops them in order. Throwing test errors are pushed
 * the same way (queue an Error instance to make the next call reject).
 *
 * Usage (top of every test file that imports anything that imports plaid):
 *   import { vi } from "vitest";
 *   import { plaidMockFactory, plaidMock, resetPlaidMock, plaidApiError }
 *     from "./helpers/plaid-mock.js";
 *   vi.mock("plaid", plaidMockFactory);
 *
 * Important: `vi.mock` MUST be called at module top level (not from inside a
 * helper function). Vitest hoists `vi.mock(...)` to before all imports, so
 * by the time `import "../src/plaid/client.js"` runs, the mock is already in
 * place. Wrapping `vi.mock` in a function defeats the hoisting and the real
 * `plaid` SDK is loaded instead — the silent root cause of "tests pass with
 * an empty queue" bugs.
 */
// A queued response is one of:
//   - `{ data }`  → the call resolves with this object
//   - `Error`     → the call rejects with this error
//   - `Promise`   → the call awaits this promise (lets tests model "pending
//                   forever" or "resolves later" — required by the soft-
//                   timeout test which pushes `new Promise(() => {})`)
type AnyResponse = { data: unknown } | Error | Promise<{ data: unknown } | Error>;

export const plaidMock = {
  linkTokenCreate: [] as AnyResponse[],
  itemPublicTokenExchange: [] as AnyResponse[],
  accountsGet: [] as AnyResponse[],
  transactionsSync: [] as AnyResponse[],
  itemRemove: [] as AnyResponse[],
};

export function resetPlaidMock(): void {
  for (const k of Object.keys(plaidMock) as (keyof typeof plaidMock)[]) {
    plaidMock[k].length = 0;
  }
}

function pop(method: keyof typeof plaidMock): AnyResponse {
  const next = plaidMock[method].shift();
  if (!next) {
    throw new Error(
      `Plaid mock has no scripted response for ${method}; the test forgot to push one`,
    );
  }
  return next;
}

async function callOrThrow(method: keyof typeof plaidMock) {
  const next = pop(method);
  // Pending-promise variant: the test wants this call to hang (or resolve
  // later via test-controlled signaling). Await the queued promise and
  // unwrap the same union as the synchronous case.
  if (next && typeof (next as Promise<unknown>).then === "function") {
    const resolved = await (next as Promise<{ data: unknown } | Error>);
    if (resolved instanceof Error) throw resolved;
    return resolved;
  }
  if (next instanceof Error) throw next;
  return next as { data: unknown };
}

/**
 * Factory passed to `vi.mock("plaid", plaidMockFactory)` at the top of test
 * files. Returns a fake `plaid` module whose PlaidApi methods consume from
 * the per-method queues in `plaidMock`. Tests push prescripted responses
 * (or Error instances to reject the next call) before invoking the code
 * under test.
 */
export function plaidMockFactory() {
  return {
    Configuration: class {
      constructor(_: unknown) {}
    },
    PlaidApi: class {
      constructor(_: unknown) {}
      async linkTokenCreate() { return callOrThrow("linkTokenCreate"); }
      async itemPublicTokenExchange() { return callOrThrow("itemPublicTokenExchange"); }
      async accountsGet() { return callOrThrow("accountsGet"); }
      async transactionsSync() { return callOrThrow("transactionsSync"); }
      async itemRemove() { return callOrThrow("itemRemove"); }
    },
    PlaidEnvironments: {
      sandbox: "https://sandbox.plaid.com",
      development: "https://development.plaid.com",
      production: "https://production.plaid.com",
    },
  };
}

/** Build a realistic `error` shape that sanitizePlaidError can read. */
export function plaidApiError(opts: {
  error_code: string;
  error_type?: string;
  error_message?: string;
  http_status?: number;
}): Error {
  const e: Error & { response?: unknown } = new Error(opts.error_message ?? opts.error_code);
  e.response = {
    status: opts.http_status ?? 400,
    data: {
      error_code: opts.error_code,
      error_type: opts.error_type ?? "ITEM_ERROR",
      error_message: opts.error_message ?? "",
      request_id: "test_req",
    },
  };
  return e;
}
```

- [ ] **Step 4: Verify it compiles + the wrapper module loads**

```bash
pnpm nx run api:typecheck
```

Expected: 0 errors. (No new tests yet — those land with services in Tasks 6–8.)

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/plaid/client.ts apps/api/tests/helpers/plaid-mock.ts
git commit -m "feat(api): plaid client wrapper + sanitized error path + test mock"
```

---

## Task 6: `plaid/lock.ts` (shared row-lock util) + `plaid/items.ts` service — store / read / strict locked remove (TDD)

**Files:**
- Create: `apps/api/src/plaid/items.ts`
- Create: `apps/api/tests/plaid.items.test.ts`

This task adds the access-token boundary — the master spec §10.1 hard rule that
Plaid functions take `(workspace_id, plaid_item_id)` and verify the pair before
decrypting. Critical to test directly (not just transitively via routes) because
the verification is what stands between us and a cross-workspace token leak.

- [ ] **Step 1: Write failing tests for the store/read/strict-remove triad**

Create `apps/api/tests/plaid.items.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { plaidMockFactory, plaidMock, resetPlaidMock, plaidApiError } from "./helpers/plaid-mock.js";

vi.mock("plaid", plaidMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { storeAccessToken, readAccessToken, removeItemStrict } from "../src/plaid/items.js";
import { HttpError } from "../src/auth/context.js";

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
};

// File-level lifecycle (Plan 2 convention) — keeps hooks consistent with the
// other plaid.* test files and avoids per-describe duplication if more
// describes are added later.
beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
});

afterAll(async () => {
  await disconnect();
});

describe("plaid/items service", () => {
  it("storeAccessToken — encrypts on write; row carries ciphertext + iv, NOT raw", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "s@x.com", name: "S" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const id = await prisma.$transaction(async (tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId,
        itemId: "item_x",
        institutionId: "ins_x",
        institutionName: "X",
        accessToken: "secret-token-do-not-leak",
      }),
    );
    const row = await prisma.plaidItem.findUniqueOrThrow({ where: { id } });
    expect(row.accessTokenIv.length).toBe(12);
    expect(row.accessTokenCiphertext.length).toBeGreaterThan(16);
    expect(Buffer.from(row.accessTokenCiphertext).toString("utf8")).not.toContain("secret-token");
    await app.close();
  });

  it("readAccessToken — round-trips when (workspaceId, plaidItemId) match", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "r1@x.com", name: "R" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId, itemId: "item_r", institutionId: "ins", institutionName: "X",
        accessToken: "secret-r",
      }),
    );
    const { accessToken } = await readAccessToken(env, wsId, id);
    expect(accessToken).toBe("secret-r");
    await app.close();
  });

  it("readAccessToken — 404 when workspaceId doesn't match the item's workspace (cross-workspace defense)", async () => {
    const app = await buildApp(env);
    const owner1 = await signUpAndGetCookie(app, { email: "o1@x.com", name: "O" });
    const ws1 = await getOwnerWorkspaceId(owner1.userId);
    const owner2 = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const ws2 = await getOwnerWorkspaceId(owner2.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: ws1, itemId: "item_cross", institutionId: "ins", institutionName: "X",
        accessToken: "secret-1",
      }),
    );
    await expect(readAccessToken(env, ws2, id)).rejects.toMatchObject({
      statusCode: 404,
      code: "not_found",
    });
    await app.close();
  });

  it("readAccessToken — 404 when plaidItemId doesn't exist", async () => {
    await expect(readAccessToken(env, "ws_nope", "no_such_item")).rejects.toBeInstanceOf(HttpError);
  });

  it("removeItemStrict — happy path: Plaid /item/remove called, accounts archived, plaid_item deleted, transactions kept", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "rm@x.com", name: "Rm" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId, itemId: "item_rm", institutionId: "ins", institutionName: "X",
        accessToken: "secret-rm",
      }),
    );
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, plaidItemId: id, plaidAccountId: "acct_rm", name: "C", type: "depository" },
    });
    const txRow = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidItemId: id,
        plaidTransactionId: "tx_rm", amount: 1, merchantRaw: "X", occurredAt: new Date(), rawData: {},
      },
    });

    plaidMock.itemRemove.push({ data: { request_id: "r" } });
    await removeItemStrict(env, wsId, id);

    expect(await prisma.plaidItem.findUnique({ where: { id } })).toBeNull();
    const acctAfter = await prisma.bankAccount.findUniqueOrThrow({ where: { id: acct.id } });
    expect(acctAfter.archivedAt).not.toBeNull();
    expect(acctAfter.plaidItemId).toBeNull(); // SetNull
    const txAfter = await prisma.transaction.findUniqueOrThrow({ where: { id: txRow.id } });
    expect(txAfter.plaidItemId).toBeNull();
    await app.close();
  });

  it("removeItemStrict — Plaid failure 502 + local row preserved for retry", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "rm2@x.com", name: "Rm" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId, itemId: "item_rm2", institutionId: "ins", institutionName: "X",
        accessToken: "secret-rm2",
      }),
    );
    plaidMock.itemRemove.push(plaidApiError({ error_code: "INSTITUTION_DOWN", http_status: 503 }));
    await expect(removeItemStrict(env, wsId, id)).rejects.toMatchObject({
      statusCode: 502,
      code: "plaid_unavailable",
    });
    expect(await prisma.plaidItem.findUnique({ where: { id } })).not.toBeNull();
    await app.close();
  });

  it("removeItemStrict — ITEM_NOT_FOUND from Plaid is treated as already-removed; local cleanup proceeds", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "rm3@x.com", name: "Rm" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const id = await prisma.$transaction((tx) =>
      storeAccessToken(env, tx, {
        workspaceId: wsId, itemId: "item_rm3", institutionId: "ins", institutionName: "X",
        accessToken: "secret-rm3",
      }),
    );
    plaidMock.itemRemove.push(plaidApiError({ error_code: "ITEM_NOT_FOUND" }));
    await removeItemStrict(env, wsId, id);
    expect(await prisma.plaidItem.findUnique({ where: { id } })).toBeNull();
    await app.close();
  });
});
```

- [ ] **Step 2: Run (expect fail — module missing)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.items.test.ts
```

Expected: FAIL.

- [ ] **Step 2.5: Create `apps/api/src/plaid/lock.ts`** (shared so both `items.ts` and `sync.ts` can use it without a circular import)

```ts
import type { Prisma } from "@prisma/client";
import { HttpError } from "../auth/context.js";

export class SyncLockHeld extends Error {
  constructor() {
    super("plaid_item is locked by another sync/disconnect");
  }
}

/**
 * Acquire a non-blocking row-level lock on the plaid_items row inside a
 * Prisma transaction. Three outcomes:
 *
 *   1. Row exists + free  → returns; lock is held until tx commits.
 *   2. Row exists + held  → Postgres raises SQLSTATE 55P03 ("could not
 *      obtain lock") immediately; we surface as `SyncLockHeld` so the
 *      caller can decide (sync returns `{skipped:"lock_held"}`, disconnect
 *      throws 409 `sync_in_progress`).
 *   3. Row vanished       → SELECT returns 0 rows. We surface as 404
 *      `not_found` so concurrent disconnect+refresh races don't get a
 *      misleading `502 plaid_unavailable` later (`Prisma P2025` would
 *      bubble up as an unhandled error otherwise).
 */
export async function lockPlaidItem(
  tx: Prisma.TransactionClient,
  plaidItemId: string,
): Promise<void> {
  let rows: { id: string }[];
  try {
    rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "plaid_items" WHERE id = ${plaidItemId} FOR UPDATE NOWAIT
    `;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "55P03" || /could not obtain lock/i.test((e as Error).message ?? "")) {
      throw new SyncLockHeld();
    }
    throw e;
  }
  if (rows.length === 0) {
    throw new HttpError(404, "not_found", "plaid_item vanished");
  }
}
```

- [ ] **Step 3: Implement `apps/api/src/plaid/items.ts`**

```ts
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { encrypt, decrypt } from "../crypto/aes-gcm.js";
import { plaidClient, mapPlaidError, isPlaidErrorCode } from "./client.js";
import { HttpError } from "../auth/context.js";
import { lockPlaidItem, SyncLockHeld } from "./lock.js";

export type StoreInput = {
  workspaceId: string;
  itemId: string;
  institutionId: string;
  institutionName: string;
  accessToken: string; // raw — only here briefly before encryption
};

/**
 * Encrypt + create the plaid_items row. Caller wraps in $transaction with the
 * accounts.createMany so item + accounts commit together.
 *
 * @returns the created plaid_items row id.
 */
export async function storeAccessToken(
  env: Env,
  tx: Pick<typeof prisma, "plaidItem">,
  input: StoreInput,
): Promise<string> {
  const { ciphertext, iv } = encrypt(env, input.accessToken, input.workspaceId);
  const created = await tx.plaidItem.create({
    data: {
      workspaceId: input.workspaceId,
      itemId: input.itemId,
      institutionId: input.institutionId,
      institutionName: input.institutionName,
      accessTokenCiphertext: ciphertext,
      accessTokenIv: iv,
    },
  });
  return created.id;
}

/**
 * Look up by (workspaceId, plaidItemId), verify ownership, decrypt. Per master
 * spec §10.1 hard rule #4 — Plaid call functions take BOTH args and verify
 * inside.
 *
 * Throws 404 not_found if either id doesn't match.
 */
export async function readAccessToken(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
): Promise<{ accessToken: string; itemRow: { id: string; itemId: string } }> {
  const row = await prisma.plaidItem.findUnique({
    where: { id: plaidItemId },
    select: {
      id: true,
      workspaceId: true,
      itemId: true,
      accessTokenCiphertext: true,
      accessTokenIv: true,
    },
  });
  if (!row || row.workspaceId !== workspaceId) {
    throw new HttpError(404, "not_found", "plaid_item not found in workspace");
  }
  const accessToken = decrypt(env, row.accessTokenCiphertext, row.accessTokenIv, workspaceId);
  return { accessToken, itemRow: { id: row.id, itemId: row.itemId } };
}

/**
 * Strict disconnect: Plaid /item/remove must succeed (or report ITEM_NOT_FOUND
 * = already removed) before the local row is touched. On other Plaid failures,
 * leave the row + encrypted token alone and surface 502 plaid_unavailable so
 * the caller can retry.
 *
 * On success: archive the accounts (archivedAt = now) and delete the plaid_item;
 * accounts.plaidItemId becomes NULL via the SetNull FK; transactions stay
 * (their plaidItemId also becomes NULL via SetNull).
 *
 * Lock contract (architecture §): the entire operation runs inside one tx
 * that takes the same `SELECT ... FOR UPDATE NOWAIT` row lock as the sync
 * page-tx, so a refresh in flight cannot apply a page mid-disconnect (and
 * vice-versa). The Plaid HTTP call happens inside the tx — disconnect is
 * a rare, user-initiated action so holding the row lock for the few seconds
 * of the Plaid round-trip is acceptable. If the lock is contended we throw
 * `409 sync_in_progress` so the caller can retry.
 */
export async function removeItemStrict(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
): Promise<void> {
  const { accessToken } = await readAccessToken(env, workspaceId, plaidItemId);

  try {
    // Prisma's interactive-tx default timeout is 5s — well under what a slow
    // Plaid `/item/remove` can take. Bump to 35s (Plaid SDK's own timeout
    // ceiling is ~30s) so a slow remote-remove doesn't leave us in the worst
    // failure mode: Plaid removed the item, then our cleanup tx aborts on
    // timeout and leaves a stale local row whose access_token is now invalid.
    // (That state IS retry-recoverable — a follow-up disconnect call will hit
    // ITEM_NOT_FOUND and clean up — but better to avoid it.)
    await prisma.$transaction(
      async (tx) => {
        await lockPlaidItem(tx, plaidItemId); // throws SyncLockHeld on 55P03
        try {
          await plaidClient(env).itemRemove({ access_token: accessToken });
        } catch (e) {
          if (isPlaidErrorCode(e, "ITEM_NOT_FOUND")) {
            // Already removed remotely. Continue with local cleanup.
          } else {
            throw mapPlaidError(e); // 502 plaid_unavailable etc.
          }
        }
        await tx.bankAccount.updateMany({
          where: { plaidItemId },
          data: { archivedAt: new Date() },
        });
        await tx.plaidItem.delete({ where: { id: plaidItemId } });
      },
      { maxWait: 5_000, timeout: 35_000 },
    );
  } catch (e) {
    if (e instanceof SyncLockHeld) {
      throw new HttpError(409, "sync_in_progress", "another sync or disconnect is in progress");
    }
    throw e;
  }
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.items.test.ts
```

Expected: 7/7 PASS.

- [ ] **Step 5: Full suite + typecheck**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
pnpm nx run api:typecheck
```

Both green.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/plaid/lock.ts apps/api/src/plaid/items.ts apps/api/tests/plaid.items.test.ts
git commit -m "feat(api): plaid items service — store/read (with (workspace, item) pair check)/strict remove"
```

---

## Task 7: `syncTransactions` — read-then-loop with per-page-tx (FOR UPDATE NOWAIT) + status-persist-tx + mutation restart

**Files:**
- Create: `apps/api/src/plaid/sync.ts`
- Create: `apps/api/tests/plaid.sync.test.ts`

This is the largest task. It builds the spec §7 sync flow: read item + cursor outside any tx, loop with per-page data transaction that takes a row-level `SELECT ... FOR UPDATE NOWAIT` on `plaid_items` (so two parallel refreshes can't both apply pages), final transaction commits `lastCursor`+`lastSyncAt` only when `has_more=false` (so any mid-loop crash leaves the cursor unmoved and the next sync naturally re-fetches from the original spot — partial-unique index makes upserts idempotent), status-persist transaction on failure (so error/relink_required survives), plus mutation-during-pagination restart per Plaid contract (catches the `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` error code, resets cursor + accumulators, max 3 restarts before surfacing as `plaid_unavailable`).

`upsertAdded` lookup uses `plaidTransactionId == t.pending_transaction_id` for promotion (the corrected key from spec review).

- [ ] **Step 1: Write failing test**

Create `apps/api/tests/plaid.sync.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { plaidMockFactory, plaidMock, resetPlaidMock, plaidApiError } from "./helpers/plaid-mock.js";

// vi.mock is HOISTED to before all imports — must be at module top, not inside
// a function. Without this, the real `plaid` SDK loads and tests fail with
// confusing "missing scripted response" or HTTP errors.
vi.mock("plaid", plaidMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { encrypt } from "../src/crypto/aes-gcm.js";


import { syncTransactions } from "../src/plaid/sync.js";

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
};

async function makeItemWithAccount(
  workspaceId: string,
  plaidAccountId = "acct_test",
): Promise<{ itemId: string; accountId: string; plaidItemId: string; plaidAccountId: string }> {
  const { ciphertext, iv } = encrypt(env, "access-test-token", workspaceId);
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId,
      itemId: `plaid_item_${Math.random().toString(36).slice(2, 10)}`,
      institutionId: "ins_1",
      institutionName: "Test Bank",
      accessTokenCiphertext: ciphertext,
      accessTokenIv: iv,
    },
  });
  const acct = await prisma.bankAccount.create({
    data: {
      workspaceId,
      plaidItemId: item.id,
      plaidAccountId, // deterministic so test mocks can reference it
      name: "Checking",
      type: "depository",
    },
  });
  return { plaidItemId: item.id, itemId: item.itemId, accountId: acct.id, plaidAccountId };
}

function tx(opts: {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  pending?: boolean;
  pending_transaction_id?: string | null;
  merchant?: string;
  authorized_date?: string;
}) {
  return {
    transaction_id: opts.transaction_id,
    account_id: opts.account_id,
    amount: opts.amount,
    date: opts.date,
    authorized_date: opts.authorized_date ?? null,
    authorized_datetime: null,
    datetime: null,
    pending: opts.pending ?? false,
    pending_transaction_id: opts.pending_transaction_id ?? null,
    merchant_name: opts.merchant ?? null,
    name: opts.merchant ?? "Unknown",
    iso_currency_code: "CAD",
  };
}

// File-level lifecycle (Plan 2 convention) — keeps hooks consistent with the
// other plaid.* test files.
beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
});

afterAll(async () => {
  await disconnect();
});

describe("syncTransactions", () => {
  it("happy path — single page applies added/modified/removed and advances cursor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId, accountId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push({
      data: {
        added: [
          tx({ transaction_id: "t1", account_id: "acct_test", amount: 12.34, date: "2026-05-10" }),
        ],
        modified: [],
        removed: [],
        next_cursor: "cursor_v1",
        has_more: false,
      },
    });

    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r).toEqual({ added: 1, modified: 0, removed: 0 });

    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
    expect(item.lastCursor).toBe("cursor_v1");
    expect(item.lastSyncAt).not.toBeNull();
    expect(item.status).toBe("active");

    const t = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(t.plaidTransactionId).toBe("t1");
    expect(t.amount.toString()).toBe("12.34");
    expect(t.accountId).toBe(accountId);
    await app.close();
  });

  it("multi-page — cursor advances per page; all 3 buckets accumulated across pages", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push(
      { data: { added: [tx({ transaction_id: "p1", account_id: "acct_test", amount: 1, date: "2026-05-09" })], modified: [], removed: [], next_cursor: "c1", has_more: true } },
      { data: { added: [tx({ transaction_id: "p2", account_id: "acct_test", amount: 2, date: "2026-05-10" })], modified: [], removed: [], next_cursor: "c2", has_more: false } },
    );

    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r).toEqual({ added: 2, modified: 0, removed: 0 });
    expect((await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } })).lastCursor).toBe("c2");
    expect(await prisma.transaction.count({ where: { workspaceId: wsId } })).toBe(2);
    await app.close();
  });

  it("pending → posted promotion via plaidTransactionId lookup, in same page", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    // Sync 1: a pending row arrives.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "pend1", account_id: "acct_test", amount: 9.99, date: "2026-05-10", pending: true })],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);
    const beforeRow = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(beforeRow.pending).toBe(true);
    expect(beforeRow.plaidTransactionId).toBe("pend1");

    // Sync 2: the posted row points back at the pending one.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({
          transaction_id: "post1",
          account_id: "acct_test",
          amount: 9.99,
          date: "2026-05-11",
          pending: false,
          pending_transaction_id: "pend1", // promotion key — old pending's transaction_id
        })],
        modified: [], removed: [], next_cursor: "c2", has_more: false,
      },
    });
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r.added).toBe(1);

    // Same row id, but Plaid id + pending state changed.
    const afterRow = await prisma.transaction.findUniqueOrThrow({ where: { id: beforeRow.id } });
    expect(afterRow.plaidTransactionId).toBe("post1");
    expect(afterRow.pending).toBe(false);
    expect(afterRow.plaidPendingTransactionId).toBe("pend1");
    expect(afterRow.postedAt).not.toBeNull();
    expect(afterRow.removedAt).toBeNull();
    expect(await prisma.transaction.count({ where: { workspaceId: wsId } })).toBe(1);
    await app.close();
  });

  it("removed-before-added across pages — promotion clears removedAt", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    // Sync 1: pending row arrives.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "pend2", account_id: "acct_test", amount: 5, date: "2026-05-10", pending: true })],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);
    const pendingRow = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });

    // Sync 2 spans TWO pages — page 1 removes the pending row (soft-delete),
    // page 2 (the posted `added`) needs to find the now-removed row by
    // plaidTransactionId == pending_transaction_id and clear removedAt.
    plaidMock.transactionsSync.push({
      data: {
        added: [],
        modified: [],
        removed: [{ transaction_id: "pend2" }],
        next_cursor: "mid", has_more: true,
      },
    });
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "post2", account_id: "acct_test", amount: 5, date: "2026-05-11", pending: false, pending_transaction_id: "pend2" })],
        modified: [], removed: [], next_cursor: "c2", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);

    const afterRow = await prisma.transaction.findUniqueOrThrow({ where: { id: pendingRow.id } });
    expect(afterRow.removedAt).toBeNull(); // promotion cleared the page-1 soft-delete
    expect(afterRow.plaidTransactionId).toBe("post2");
    expect(afterRow.pending).toBe(false);
    expect(await prisma.transaction.count({ where: { workspaceId: wsId } })).toBe(1);
    await app.close();
  });

  it("modified — updates row in place", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "m1", account_id: "acct_test", amount: 1.0, date: "2026-05-10", merchant: "Old" })],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);
    plaidMock.transactionsSync.push({
      data: {
        added: [],
        modified: [tx({ transaction_id: "m1", account_id: "acct_test", amount: 1.5, date: "2026-05-10", merchant: "New" })],
        removed: [],
        next_cursor: "c2", has_more: false,
      },
    });
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r.modified).toBe(1);
    const after = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(after.merchantRaw).toBe("New");
    expect(after.amount.toString()).toBe("1.5");
    await app.close();
  });

  it("removed — sets removedAt", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "r1", account_id: "acct_test", amount: 1, date: "2026-05-10" })],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    await syncTransactions(env, wsId, plaidItemId);
    plaidMock.transactionsSync.push({
      data: { added: [], modified: [], removed: [{ transaction_id: "r1" }], next_cursor: "c2", has_more: false },
    });
    const r = await syncTransactions(env, wsId, plaidItemId);
    expect(r.removed).toBe(1);
    const after = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(after.removedAt).not.toBeNull();
    await app.close();
  });

  it("ITEM_LOGIN_REQUIRED — status persists (separate tx) AND error is rethrown", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push(
      plaidApiError({ error_code: "ITEM_LOGIN_REQUIRED", error_message: "log in" }),
    );

    await expect(syncTransactions(env, wsId, plaidItemId)).rejects.toMatchObject({
      statusCode: 409,
      code: "plaid_login_required",
    });
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
    expect(item.status).toBe("relink_required");
    expect(item.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    await app.close();
  });

  it("generic Plaid error — status = error + 502 plaid_unavailable", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o8@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push(plaidApiError({ error_code: "INSTITUTION_DOWN", http_status: 503 }));
    await expect(syncTransactions(env, wsId, plaidItemId)).rejects.toMatchObject({
      statusCode: 502,
      code: "plaid_unavailable",
    });
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
    expect(item.status).toBe("error");
    expect(item.errorCode).toBe("INSTITUTION_DOWN");
    await app.close();
  });

  it("mutation-during-pagination — error code triggers loop restart from originalCursor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o9@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    // Page 1 of attempt #1: applies 1 row, has_more = true. Row is committed
    // (per-page commit) but lastCursor is NOT updated yet — that only happens
    // at has_more=false.
    plaidMock.transactionsSync.push({
      data: {
        added: [tx({ transaction_id: "first", account_id: "acct_test", amount: 1, date: "2026-05-09" })],
        modified: [], removed: [], next_cursor: "c1", has_more: true,
      },
    });
    // Page 2 of attempt #1: Plaid raises the documented error mid-pagination.
    // Our loop catches by error code, resets cursor to originalCursor, restarts.
    plaidMock.transactionsSync.push(
      plaidApiError({ error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }),
    );
    // Attempt #2 page 1: re-fetches from originalCursor (=null since fresh
    // item). Returns the same "first" row — upsert is idempotent (partial
    // unique on plaidTransactionId). Plus 2 newer rows.
    plaidMock.transactionsSync.push({
      data: {
        added: [
          tx({ transaction_id: "first", account_id: "acct_test", amount: 1, date: "2026-05-09" }),
          tx({ transaction_id: "after1", account_id: "acct_test", amount: 1, date: "2026-05-10" }),
          tx({ transaction_id: "after2", account_id: "acct_test", amount: 2, date: "2026-05-10" }),
        ],
        modified: [], removed: [], next_cursor: "c2", has_more: false,
      },
    });

    const r = await syncTransactions(env, wsId, plaidItemId);
    // After restart, the second-attempt page returned 3 added (re-applying the
    // previously-seen "first" + 2 new). Accumulators were reset on restart so
    // the count reflects only the second attempt.
    expect(r).toEqual({ added: 3, modified: 0, removed: 0 });
    const all = await prisma.transaction.findMany({ where: { workspaceId: wsId } });
    expect(all.map((t) => t.plaidTransactionId).sort()).toEqual(["after1", "after2", "first"]);
    // lastCursor only advances on the final successful page (has_more=false in
    // attempt #2). Verify the cursor is persisted now.
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
    expect(item.lastCursor).toBe("c2");
    await app.close();
  });

  it("row-lock contention — sync returns lock_held when another tx holds the row", async () => {
    // We can't reliably exercise contention with two `Promise.all`-launched
    // syncTransactions calls — the Plaid mock is FIFO and the JS event loop
    // tends to serialize them, so both look "successful" in turn. The real
    // production race is sync-vs-disconnect (or sync-vs-cron), so model that
    // by holding the row lock in an out-of-band transaction and verifying
    // syncTransactions hits SyncLockHeld → returns `{skipped:"lock_held"}`.
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o10@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const { plaidItemId } = await makeItemWithAccount(wsId);

    plaidMock.transactionsSync.push({
      data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false },
    });

    // Coordinate via promises rather than setTimeout — the latter is racy
    // on slow CI hosts (50ms can pass before the holder tx actually got the
    // lock). `acquired` resolves the moment the SELECT returns; `released`
    // is set by the test body to let the holder commit and free the lock.
    let signalAcquired: () => void = () => {};
    const acquired = new Promise<void>((r) => (signalAcquired = r));
    let releaseHolder: () => void = () => {};
    const released = new Promise<void>((r) => (releaseHolder = r));
    const holderTx = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "plaid_items" WHERE id = ${plaidItemId} FOR UPDATE`;
      signalAcquired();
      await released;
    });
    try {
      await acquired;

      const r = await syncTransactions(env, wsId, plaidItemId);
      expect(r).toEqual({ skipped: "lock_held", added: 0, modified: 0, removed: 0 });
      // syncTransactions calls Plaid BEFORE attempting the per-page row lock,
      // so the mock response IS consumed (then discarded when the per-page tx
      // aborts on SyncLockHeld). Verify by asserting nothing landed in the DB:
      // no transactions, and lastCursor on the plaid_item is unchanged.
      expect(plaidMock.transactionsSync.length).toBe(0); // popped by the call
      expect(await prisma.transaction.count({ where: { workspaceId: wsId } })).toBe(0);
      const itemRow = await prisma.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
      expect(itemRow.lastCursor).toBeNull();
    } finally {
      // Always release the holder, even on assertion failure — otherwise the
      // tx sits in Postgres holding the row lock until vitest's idle timeout
      // and the failure surfaces as a confusing hang instead of the actual
      // assertion error.
      releaseHolder();
      await holderTx;
    }
    await app.close();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.sync.test.ts
```

Expected: FAIL — `syncTransactions not exported`.

- [ ] **Step 3: Implement `apps/api/src/plaid/sync.ts`**

```ts
import { Prisma } from "@prisma/client";
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { plaidClient, isPlaidErrorCode, isPlaidApiError, sanitizePlaidError, mapPlaidError } from "./client.js";
import { readAccessToken } from "./items.js";
import { lockPlaidItem, SyncLockHeld } from "./lock.js";
import { HttpError } from "../auth/context.js";

// `skipped` carries the partial counters from any pages that DID commit
// before the lock was lost (final-tx race) — the page-level commits are
// real and the user can see them. So the skipped variant uses `number`,
// not literal 0. Routes that re-emit a "lock_held" response can still pass
// zero-counters at the boundary if they prefer; the type doesn't force it.
export type SyncResult =
  | { added: number; modified: number; removed: number }
  | { skipped: "lock_held"; added: number; modified: number; removed: number };

export function plaidOccurredAt(t: PlaidTxLike): Date {
  // Prefer authorized_* (when the user actually transacted), fall back to date.
  const v = t.authorized_datetime ?? t.authorized_date ?? t.datetime ?? t.date;
  return new Date(v);
}

export function plaidPostedAt(t: PlaidTxLike): Date | null {
  if (t.pending) return null;
  const v = t.datetime ?? t.date;
  return new Date(v);
}

type PlaidTxLike = {
  transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  authorized_date?: string | null;
  authorized_datetime?: string | null;
  datetime?: string | null;
  pending: boolean;
  pending_transaction_id?: string | null;
  merchant_name?: string | null;
  name?: string | null;
  iso_currency_code?: string | null;
};

type PlaidPageData = {
  added: PlaidTxLike[];
  modified: PlaidTxLike[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
};

const MAX_MUTATION_RESTARTS = 3;

export async function syncTransactions(env: Env, workspaceId: string, plaidItemId: string): Promise<SyncResult> {
  // Read item once outside any tx so we have the original cursor even if the
  // first per-page lock attempt fails. No lock here — we don't need one to
  // simply read encrypted bytes + cursor for our own loop bookkeeping.
  const item = await prisma.plaidItem.findUnique({
    where: { id: plaidItemId },
    select: { workspaceId: true, lastCursor: true },
  });
  if (!item || item.workspaceId !== workspaceId) {
    throw new HttpError(404, "not_found", "plaid_item not found in workspace");
  }

  const { accessToken } = await readAccessToken(env, workspaceId, plaidItemId);
  const originalCursor = item.lastCursor ?? null;
  let cursor: string | null = originalCursor;
  let added = 0, modified = 0, removed = 0;
  let restarts = 0;

  try {
    pageLoop: while (true) {
      let pageData: PlaidPageData;
      try {
        const res = await plaidClient(env).transactionsSync({
          access_token: accessToken,
          cursor: cursor ?? undefined,
        });
        pageData = res.data as PlaidPageData;
      } catch (e) {
        // Plaid emits TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION (an error
        // code) when the item changed mid-pagination. Per Plaid docs the
        // client must restart from the ORIGINAL cursor and discard whatever
        // partial state it had. Any committed page rows stay (they're still
        // valid Plaid state); the cursor in DB hasn't moved (we only commit
        // it at has_more=false) so the restart is naturally idempotent.
        if (isPlaidErrorCode(e, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")) {
          restarts++;
          if (restarts > MAX_MUTATION_RESTARTS) {
            // Pathological: the item is changing faster than we can read.
            // Surface as plaid_unavailable so client can back off.
            throw e;
          }
          cursor = originalCursor;
          added = modified = removed = 0;
          continue pageLoop;
        }
        throw e;
      }

      // Per-page tx: row-lock the plaid_items row + apply this page's
      // added/modified/removed. lastCursor + lastSyncAt are NOT updated here —
      // see the final-page tx after the loop. That way under any mid-loop
      // failure the next sync simply re-fetches from the original cursor;
      // partial-unique index makes the upserts idempotent.
      try {
        await prisma.$transaction(async (tx) => {
          await lockPlaidItem(tx, plaidItemId); // FOR UPDATE NOWAIT — throws SyncLockHeld if held
          for (const t of pageData.added)    { await upsertAdded(tx, t, plaidItemId, workspaceId);    added++; }
          for (const t of pageData.modified) { await upsertModified(tx, t, workspaceId); modified++; }
          for (const t of pageData.removed)  { await markRemoved(tx, t.transaction_id, workspaceId); removed++; }
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (e) {
        if (e instanceof SyncLockHeld) {
          // Pass through whatever counters previous pages already committed
          // (the per-page tx is the unit of durability — earlier pages are
          // safely on disk even though this one rolled back). The route
          // returns the shape verbatim so the UI can show "got N before
          // yielding to another sync."
          return { skipped: "lock_held", added, modified, removed };
        }
        throw e;
      }

      cursor = pageData.next_cursor;
      if (!pageData.has_more) break;
    }

    // ---- Final tx: commit lastCursor + lastSyncAt + status=active ----
    // Same row lock as per-page so disconnect can't slip in here either.
    try {
      await prisma.$transaction(async (tx) => {
        await lockPlaidItem(tx, plaidItemId);
        await tx.plaidItem.update({
          where: { id: plaidItemId },
          data: { lastCursor: cursor, lastSyncAt: new Date(), status: "active", errorCode: null },
        });
      });
    } catch (e) {
      if (e instanceof SyncLockHeld) {
        return { skipped: "lock_held", added, modified, removed };
      }
      throw e;
    }

    return { added, modified, removed };
  } catch (e) {
    // Persist status in a SEPARATE short tx so it survives the rethrow.
    if (isPlaidErrorCode(e, "ITEM_LOGIN_REQUIRED")) {
      await prisma.plaidItem.update({
        where: { id: plaidItemId },
        data: { status: "relink_required", errorCode: "ITEM_LOGIN_REQUIRED" },
      });
      throw mapPlaidError(e); // 409 plaid_login_required
    }
    if (isPlaidApiError(e)) {
      const s = sanitizePlaidError(e);
      await prisma.plaidItem.update({
        where: { id: plaidItemId },
        data: { status: "error", errorCode: s.error_code ?? "unknown" },
      });
      throw mapPlaidError(e); // 502 plaid_unavailable
    }
    throw e;
  }
}

async function accountIdForPlaidAccount(
  tx: Prisma.TransactionClient,
  plaidItemId: string,
  plaidAccountId: string,
): Promise<string> {
  // Strict — the exchange handler must have created the bank_accounts row
  // for every Plaid `account_id` we'll see in transactions. If a transaction
  // arrives with an account_id we don't know, that's a bug we want to fail
  // loudly on (rather than silently quartering it on an unrelated account).
  // Tests must use the same plaidAccountId in their mock transactions as
  // they used in their account fixture.
  const acct = await tx.bankAccount.findFirstOrThrow({
    where: { plaidItemId, plaidAccountId },
    select: { id: true },
  });
  return acct.id;
}

export async function upsertAdded(
  tx: Prisma.TransactionClient,
  t: PlaidTxLike,
  plaidItemId: string,
  workspaceId: string,
): Promise<void> {
  // Promotion path: posted row points back at an existing pending row.
  if (t.pending_transaction_id) {
    const promotion = await tx.transaction.findFirst({
      where: {
        workspaceId,
        plaidTransactionId: t.pending_transaction_id, // OLD pending row's transaction_id
      },
      select: { id: true },
    });
    if (promotion) {
      await tx.transaction.update({
        where: { id: promotion.id },
        data: {
          plaidTransactionId: t.transaction_id,
          plaidPendingTransactionId: t.pending_transaction_id,
          pending: false,
          occurredAt: plaidOccurredAt(t),
          postedAt: plaidPostedAt(t),
          amount: t.amount,
          merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
          rawData: t as unknown as Prisma.InputJsonValue,
          removedAt: null, // promote restores any earlier soft-removal
        },
      });
      return;
    }
  }

  // Fresh-insert path: create or update by partial unique
  // (workspaceId, plaidTransactionId). Prisma can't model the partial unique
  // directly, so we try create + fall back to update on P2002.
  const accountId = await accountIdForPlaidAccount(tx, plaidItemId, t.account_id);
  try {
    await tx.transaction.create({
      data: {
        workspaceId,
        accountId,
        plaidItemId,
        plaidTransactionId: t.transaction_id,
        plaidPendingTransactionId: t.pending_transaction_id ?? null,
        amount: t.amount,
        currency: t.iso_currency_code ?? "CAD",
        merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
        occurredAt: plaidOccurredAt(t),
        postedAt: plaidPostedAt(t),
        pending: t.pending,
        rawData: t as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Webhook replay or race — treat as idempotent update.
      await tx.transaction.updateMany({
        where: { workspaceId, plaidTransactionId: t.transaction_id },
        data: {
          amount: t.amount,
          merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
          occurredAt: plaidOccurredAt(t),
          postedAt: plaidPostedAt(t),
          pending: t.pending,
          rawData: t as unknown as Prisma.InputJsonValue,
        },
      });
      return;
    }
    throw e;
  }
}

export async function upsertModified(
  tx: Prisma.TransactionClient,
  t: PlaidTxLike,
  workspaceId: string,
): Promise<void> {
  await tx.transaction.updateMany({
    where: { workspaceId, plaidTransactionId: t.transaction_id },
    data: {
      amount: t.amount,
      merchantRaw: t.merchant_name ?? t.name ?? "Unknown",
      occurredAt: plaidOccurredAt(t),
      postedAt: plaidPostedAt(t),
      pending: t.pending,
      rawData: t as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function markRemoved(
  tx: Prisma.TransactionClient,
  plaidTransactionId: string,
  workspaceId: string,
): Promise<void> {
  await tx.transaction.updateMany({
    where: { workspaceId, plaidTransactionId, removedAt: null },
    data: { removedAt: new Date() },
  });
}
```

- [ ] **Step 4: Run sync tests (expect pass)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.sync.test.ts
```

Expected: 10/10 PASS.

- [ ] **Step 5: Full suite check**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 109/109 (99 prior — Plan 2 baseline 82 + Task 3 crypto 6 + Task 4 tier 4 + Task 6 items 7 — plus 10 sync).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/plaid/sync.ts apps/api/tests/plaid.sync.test.ts
git commit -m "feat(api): syncTransactions — row-level lock (FOR UPDATE NOWAIT) + per-page commit + status-persist tx + mutation-during-pagination restart"
```

---

## Task 8: Routes — `routes/plaid.ts` (link-token + exchange with `syncOk` partial-failure)

**Files:**
- Create: `apps/api/src/routes/plaid.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/plaid.exchange.test.ts`

The exchange handler creates the item + accounts in one transaction, then runs initial sync separately. If sync fails, the item is durable; the response carries `syncOk: false` and the user can Refresh later. This was a Critical from spec review (without the split, retrying after sync failure hits `already_connected` forever).

- [ ] **Step 1: Write failing tests**

Create `apps/api/tests/plaid.exchange.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { plaidMockFactory, plaidMock, resetPlaidMock, plaidApiError } from "./helpers/plaid-mock.js";

vi.mock("plaid", plaidMockFactory);

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
};

// File-level lifecycle: every test in this file needs the same fresh
// DB + mock state, and we only want to disconnect Prisma once at the end.
// Defining these inside each describe duplicates work and risks one block's
// afterAll closing the connection while the other block is mid-test.
beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
});

afterAll(async () => {
  await disconnect();
});

describe("POST /workspaces/:id/plaid/link-token", () => {
  it("happy path — owner Pro user gets a linkToken", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ow@x.com", name: "OW" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    plaidMock.linkTokenCreate.push({ data: { link_token: "link_test", expiration: "2026-05-12T00:00:00Z" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ linkToken: "link_test", expiration: "2026-05-12T00:00:00Z" });
    await app.close();
  });

  it("402 upgrade_required for free-tier user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "free@x.com", name: "Free" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    await app.close();
  });

  it("403 when caller is not owner of the workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow2@x.com", name: "OW2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m@x.com", name: "M" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/link-token`,
      headers: { cookie: member.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    // Caller is owner of workspace A but submits B in the URL while their
    // active-workspace cookie / X-Workspace-Id header is A. The route guards
    // this regardless of role to prevent header-spoof CSRF-shaped attacks.
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ww@x.com", name: "WW" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/plaid/link-token`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});

describe("POST /workspaces/:id/plaid/exchange", () => {
  function pushExchangeAndAccounts(itemId = "item_test") {
    plaidMock.itemPublicTokenExchange.push({
      data: { access_token: "access_test", item_id: itemId, request_id: "req" },
    });
    plaidMock.accountsGet.push({
      data: {
        accounts: [
          { account_id: "acct_1", name: "Checking", official_name: null, mask: "0001", type: "depository", subtype: "checking", balances: { current: 100, available: 100, limit: null, iso_currency_code: "CAD" } },
        ],
        item: { item_id: itemId, institution_id: "ins_1" },
        request_id: "req",
      },
    });
  }

  it("happy — item + account + transactions created; syncOk: true", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts();
    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "tx_1", account_id: "acct_1", amount: 5, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "Coffee", name: "Coffee", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "public_test", institutionId: "ins_1", institutionName: "Test Bank" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncOk).toBe(true);
    expect(body.accountCount).toBe(1);
    expect(body.transactionCount).toBe(1);
    expect(typeof body.plaidItemId).toBe("string");

    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: body.plaidItemId } });
    expect(item.itemId).toBe("item_test");
    expect(item.institutionName).toBe("Test Bank");
    expect(await prisma.bankAccount.count({ where: { plaidItemId: item.id } })).toBe(1);
    expect(await prisma.transaction.count({ where: { plaidItemId: item.id } })).toBe(1);
    await app.close();
  });

  it("422 already_connected — second exchange of the same item_id", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_dup");
    plaidMock.transactionsSync.push({ data: { added: [], modified: [], removed: [], next_cursor: "c1", has_more: false } });
    await app.inject({
      method: "POST", url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p1", institutionId: "ins_1", institutionName: "TB" }),
    });

    pushExchangeAndAccounts("item_dup"); // same item_id
    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p2", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("already_connected");
    await app.close();
  });

  it("410 plaid_link_expired — INVALID_PUBLIC_TOKEN from Plaid", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    plaidMock.itemPublicTokenExchange.push(plaidApiError({ error_code: "INVALID_PUBLIC_TOKEN" }));
    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "stale", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("plaid_link_expired");
    await app.close();
  });

  it("partial failure — initial sync errors but item is durable; 200 with syncOk: false", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_partial");
    plaidMock.transactionsSync.push(plaidApiError({ error_code: "INSTITUTION_DOWN", http_status: 503 }));

    const res = await app.inject({
      method: "POST", url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncOk).toBe(false);
    expect(body.transactionCount).toBe(0);
    expect(body.accountCount).toBe(1);

    // Item is durable + status reflects the failure.
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: body.plaidItemId } });
    expect(item.status).toBe("error");
    expect(item.errorCode).toBe("INSTITUTION_DOWN");
    await app.close();
  });

  it("402 upgrade_required for free-tier user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "free2@x.com", name: "Free" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    // Crucial: never call Plaid for free-tier callers.
    expect(plaidMock.itemPublicTokenExchange.length).toBe(0);
    await app.close();
  });

  it("403 when caller is not owner of the workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow3@x.com", name: "OW" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const editor = await signUpAndGetCookie(app, { email: "ed@x.com", name: "ED" });
    await prisma.membership.create({
      data: { userId: editor.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: editor.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(403);
    expect(plaidMock.itemPublicTokenExchange.length).toBe(0);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "wmx@x.com", name: "W" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/plaid/exchange`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });

  it("soft timeout — initial sync exceeds deadline; 200 with syncOk: false", async () => {
    // Real timers + a 50ms deadline override (PLAID_SYNC_TIMEOUT_MS in env).
    // We tried fake timers + advanceTimersByTimeAsync first; it raced badly
    // with fastify.inject + Prisma's microtask scheduling and either hung or
    // resolved before the handler had registered its setTimeout. A real,
    // small timer is far simpler and adds ~50ms to the run.
    const fastTimeoutEnv = { ...env, PLAID_SYNC_TIMEOUT_MS: 50 };
    const app = await buildApp(fastTimeoutEnv);
    const owner = await signUpAndGetCookie(app, { email: "slow@x.com", name: "S" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    pushExchangeAndAccounts("item_slow");
    // Hang transactionsSync forever so the timeout wins the race.
    plaidMock.transactionsSync.push(new Promise(() => {}));

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.syncOk).toBe(false);
    expect(body.transactionCount).toBe(0);
    // Item is still durable so the user can hit Refresh later.
    expect(typeof body.plaidItemId).toBe("string");
    // Spec §7: deadline-hit initial sync persists status="error" + sync_timeout
    // so the UI knows to prompt for retry.
    const item = await prisma.plaidItem.findUniqueOrThrow({ where: { id: body.plaidItemId } });
    expect(item.status).toBe("error");
    expect(item.errorCode).toBe("sync_timeout");
    await app.close();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.exchange.test.ts
```

Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement `apps/api/src/routes/plaid.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { requireProTier } from "../auth/tier.js";
import { plaidClient, mapPlaidError, PLAID_PRODUCTS, PLAID_COUNTRY_CODES } from "../plaid/client.js";
import { storeAccessToken } from "../plaid/items.js";
import { syncTransactions } from "../plaid/sync.js";

const ExchangeBody = z.object({
  publicToken: z.string().min(1),
  institutionId: z.string().min(1),
  institutionName: z.string().min(1),
});

export async function plaidRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/plaid/link-token", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      await requireProTier(ctx.session.userId);
      const res = await plaidClient(app.fina.env).linkTokenCreate({
        user: { client_user_id: ctx.session.userId },
        client_name: "Fina",
        products: PLAID_PRODUCTS,
        country_codes: PLAID_COUNTRY_CODES,
        language: "en",
      });
      return { linkToken: res.data.link_token, expiration: res.data.expiration };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapPlaidError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.post("/workspaces/:id/plaid/exchange", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = ExchangeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    let plaidItemId: string;
    let accountCount: number;
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      await requireProTier(ctx.session.userId);

      // ---- Step 1: Plaid exchange + accounts/get ----
      const exch = await plaidClient(app.fina.env).itemPublicTokenExchange({
        public_token: parsed.data.publicToken,
      });
      const accountsRes = await plaidClient(app.fina.env).accountsGet({
        access_token: exch.data.access_token,
      });

      // ---- Step 2: Item + accounts in one tx ----
      const result = await prisma.$transaction(async (tx) => {
        const itemRowId = await storeAccessToken(app.fina.env, tx, {
          workspaceId: ctx.membership.workspaceId,
          itemId: exch.data.item_id,
          institutionId: parsed.data.institutionId,
          institutionName: parsed.data.institutionName,
          accessToken: exch.data.access_token,
        });
        for (const a of accountsRes.data.accounts) {
          await tx.bankAccount.create({
            data: {
              workspaceId: ctx.membership.workspaceId,
              plaidItemId: itemRowId,
              plaidAccountId: a.account_id,
              name: a.name,
              officialName: a.official_name ?? null,
              mask: a.mask ?? null,
              type: a.type,
              subtype: a.subtype ?? null,
              currency: a.balances?.iso_currency_code ?? "CAD",
              balanceCurrent: a.balances?.current ?? null,
              balanceAvailable: a.balances?.available ?? null,
              balanceLimit: a.balances?.limit ?? null,
              lastBalanceSyncAt: new Date(),
            },
          });
        }
        return { itemRowId, accountCount: accountsRes.data.accounts.length };
      });

      plaidItemId = result.itemRowId;
      accountCount = result.accountCount;
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return reply.code(422).send({ error: "already_connected" });
      }
      const m = mapPlaidError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }

    // ---- Step 3: Initial sync — separate, partial-failure tolerant + soft timeout ----
    // The connect flow blocks on this; if Plaid sandbox or a slow institution
    // takes >30s to first-page sync, we'd hang the user's browser. Race against
    // a 30s deadline and report `syncOk: false` (the item is durable, the user
    // can hit Refresh later or wait for the next cron tick once that ships).
    //
    // Deadline is overridable via `app.fina.env.PLAID_SYNC_TIMEOUT_MS` so the
    // test suite can exercise the timeout path with a real (small) timer
    // instead of fighting vi.useFakeTimers + fastify.inject.
    const SYNC_DEADLINE_MS = app.fina.env.PLAID_SYNC_TIMEOUT_MS ?? 30_000;
    let transactionCount = 0;
    let syncOk = true;
    try {
      const wsId = (req.headers["x-workspace-id"] as string)!;
      const r = await Promise.race([
        syncTransactions(app.fina.env, wsId, plaidItemId),
        new Promise<{ skipped: "deadline" }>((resolve) =>
          setTimeout(() => resolve({ skipped: "deadline" }), SYNC_DEADLINE_MS),
        ),
      ]);
      if ("skipped" in r) {
        syncOk = false;
        if (r.skipped === "deadline") {
          // Spec §7: a deadline-hit initial sync leaves the item in `error`
          // with `errorCode = "sync_timeout"` so the UI knows to prompt the
          // user to retry (vs. the vanishingly-rare `lock_held` on a brand-
          // new item, which we leave alone — the racing sync will set its
          // own status when it finishes).
          await prisma.plaidItem.update({
            where: { id: plaidItemId },
            data: { status: "error", errorCode: "sync_timeout" },
          });
        }
      } else {
        transactionCount = r.added;
      }
    } catch {
      // Status was already persisted inside syncTransactions's catch.
      syncOk = false;
    }

    return reply.code(200).send({ plaidItemId, accountCount, transactionCount, syncOk });
  });
}
```

- [ ] **Step 4: Register the route in `server.ts`**

Edit `apps/api/src/server.ts`. Add the import and register call after the existing `inviteRoutes` registration:

```ts
import { plaidRoutes } from "./routes/plaid.js";
```

After `await app.register(inviteRoutes);`:

```ts
  await app.register(plaidRoutes);
```

- [ ] **Step 5: Run exchange tests (expect pass)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.exchange.test.ts
```

Expected: 12/12 PASS (4 link-token + 8 exchange).

- [ ] **Step 6: Full suite**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 121/121 (109 prior + 12 exchange).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/plaid.ts apps/api/src/server.ts apps/api/tests/plaid.exchange.test.ts
git commit -m "feat(api): /workspaces/:id/plaid/{link-token,exchange} routes with syncOk partial-failure contract"
```

---

## Task 9: Routes — `routes/plaid-items.ts` (list + sync + strict locked disconnect)

**Files:**
- Create: `apps/api/src/routes/plaid-items.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/plaid.routes.test.ts` (route-level tests for list/sync/disconnect)

- [ ] **Step 1: Write failing tests**

Create `apps/api/tests/plaid.routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { plaidMockFactory, plaidMock, resetPlaidMock, plaidApiError } from "./helpers/plaid-mock.js";

vi.mock("plaid", plaidMockFactory);

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
};

async function connectAItem(app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never, owner: { cookie: string }, wsId: string, suffix = ""): Promise<string> {
  plaidMock.itemPublicTokenExchange.push({
    data: { access_token: `access${suffix}`, item_id: `item${suffix}`, request_id: "req" },
  });
  plaidMock.accountsGet.push({
    data: {
      accounts: [
        { account_id: `acct${suffix}`, name: "Checking", official_name: null, mask: "0001", type: "depository", subtype: "checking", balances: { current: 100, available: 100, limit: null, iso_currency_code: "CAD" } },
      ],
      item: { item_id: `item${suffix}`, institution_id: "ins_1" },
      request_id: "req",
    },
  });
  plaidMock.transactionsSync.push({ data: { added: [], modified: [], removed: [], next_cursor: "c0", has_more: false } });
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${wsId}/plaid/exchange`,
    headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({ publicToken: `p${suffix}`, institutionId: "ins_1", institutionName: `Test Bank${suffix}` }),
  });
  return res.json().plaidItemId as string;
}

// File-level lifecycle: every test in this file shares the same fresh DB +
// mock state. We disconnect Prisma exactly once after the whole file.
beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
});

afterAll(async () => {
  await disconnect();
});

describe("GET /workspaces/:id/plaid-items", () => {
  it("members can list — returns institutionName, status, accountCount", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await connectAItem(app, owner, wsId);

    // Add a viewer member.
    const viewer = await signUpAndGetCookie(app, { email: "v@x.com", name: "V" });
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" },
    });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/plaid-items`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().plaidItems;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      institutionName: "Test Bank",
      status: "active",
      accountCount: 1,
    });
    expect(typeof list[0].id).toBe("string");
    await app.close();
  });

  it("404 for non-member workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "x@x.com", name: "X" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/plaid-items`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "wm@x.com", name: "W" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsB}/plaid-items`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});

describe("POST /workspaces/:id/plaid-items/:itemId/sync", () => {
  it("owner Pro user — happy path returns counts", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "t99", account_id: "acct", amount: 1, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "X", name: "X", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "c1", has_more: false,
      },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ added: 1, modified: 0, removed: 0 });
    await app.close();
  });

  it("403 for viewer member (Pro-mutating routes are owner-only)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    const viewer = await signUpAndGetCookie(app, { email: "v2@x.com", name: "V" });
    await prisma.membership.create({ data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" } });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "wms@x.com", name: "O" });
    const wsA = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsA);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });

  it("402 upgrade_required when the owner's trial has expired (free tier)", async () => {
    // Sync IS Pro-gated (unlike disconnect — see DELETE describe). A user
    // whose trial expired can read existing transactions but can't pull
    // new ones until they upgrade.
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "fr@x.com", name: "F" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    await prisma.user.update({
      where: { id: owner.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
    await app.close();
  });
});

describe("DELETE /workspaces/:id/plaid-items/:itemId", () => {
  it("strict — Plaid /item/remove called first; then accounts archived + plaid_item deleted; transactions kept", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    // Add a transaction so we can verify it survives.
    plaidMock.transactionsSync.push({
      data: {
        added: [
          { transaction_id: "tkeep", account_id: "acct", amount: 1, date: "2026-05-10", authorized_date: null, authorized_datetime: null, datetime: null, pending: false, pending_transaction_id: null, merchant_name: "X", name: "X", iso_currency_code: "CAD" },
        ],
        modified: [], removed: [], next_cursor: "cN", has_more: false,
      },
    });
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    plaidMock.itemRemove.push({ data: { request_id: "req" } });

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);

    expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).toBeNull();
    // Account survives but is archived; plaidItemId becomes NULL via SetNull.
    const acct = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(acct.archivedAt).not.toBeNull();
    expect(acct.plaidItemId).toBeNull();
    // Transaction survives.
    const tx = await prisma.transaction.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(tx.plaidTransactionId).toBe("tkeep");
    expect(tx.plaidItemId).toBeNull();
    await app.close();
  });

  it("Plaid failure → 502 plaid_unavailable AND local row preserved for retry", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    plaidMock.itemRemove.push(plaidApiError({ error_code: "INSTITUTION_DOWN", http_status: 503 }));

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("plaid_unavailable");
    expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).not.toBeNull();
    await app.close();
  });

  it("ITEM_NOT_FOUND from Plaid is treated as already-removed; local cleanup proceeds", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);

    plaidMock.itemRemove.push(plaidApiError({ error_code: "ITEM_NOT_FOUND" }));
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).toBeNull();
    await app.close();
  });

  it("403 for viewer trying to disconnect (owner-only)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    const viewer = await signUpAndGetCookie(app, { email: "v4@x.com", name: "V" });
    await prisma.membership.create({ data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" } });

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "wmd@x.com", name: "O" });
    const wsA = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsA);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsB}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    // Plaid /item/remove must NOT be called when the request is rejected.
    expect(plaidMock.itemRemove.length).toBe(0);
    await app.close();
  });

  it("free-tier owner CAN disconnect — deliberate exception to the Pro gate", async () => {
    // Disconnect is owner-only but NOT Pro-gated, so a user whose trial has
    // expired isn't trapped — they can still revoke Plaid's access.
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "fd@x.com", name: "F" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    await prisma.user.update({
      where: { id: owner.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    plaidMock.itemRemove.push({ data: { request_id: "req" } });

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).toBeNull();
    await app.close();
  });

  it("409 sync_in_progress — disconnect while another tx holds the row lock", async () => {
    // Hold the row lock from outside the route handler in a second connection
    // (Prisma uses one connection per $transaction). The disconnect's
    // `SELECT ... FOR UPDATE NOWAIT` then fails with 55P03 → SyncLockHeld →
    // 409 sync_in_progress.
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "lk@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const plaidItemId = await connectAItem(app, owner, wsId);
    plaidMock.itemRemove.push({ data: { request_id: "req" } });

    // Coordinate via promises (see the parallel sync.test.ts test for why
    // setTimeout-based coordination is too racy on CI).
    let signalAcquired: () => void = () => {};
    const acquired = new Promise<void>((r) => (signalAcquired = r));
    let releaseHolder: () => void = () => {};
    const released = new Promise<void>((r) => (releaseHolder = r));
    const holderTx = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "plaid_items" WHERE id = ${plaidItemId} FOR UPDATE`;
      signalAcquired();
      await released;
    });
    try {
      await acquired;

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/plaid-items/${plaidItemId}`,
        headers: { cookie: owner.cookie, "x-workspace-id": wsId },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("sync_in_progress");
      // Plaid /item/remove must NOT have been called — the lock blocked us
      // before the Plaid HTTP call.
      expect(plaidMock.itemRemove.length).toBe(1); // pushed but not consumed
      // Local row is still intact; the user can retry.
      expect(await prisma.plaidItem.findUnique({ where: { id: plaidItemId } })).not.toBeNull();
    } finally {
      // Always release — see the matching note on the sync.test.ts test.
      releaseHolder();
      await holderTx;
    }
    await app.close();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.routes.test.ts
```

Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement `apps/api/src/routes/plaid-items.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { requireProTier } from "../auth/tier.js";
import { syncTransactions } from "../plaid/sync.js";
import { removeItemStrict } from "../plaid/items.js";
import { mapPlaidError } from "../plaid/client.js";

export async function plaidItemsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/plaid-items", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const items = await prisma.plaidItem.findMany({
        where: { workspaceId: ctx.membership.workspaceId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          institutionName: true,
          status: true,
          errorCode: true,
          lastSyncAt: true,
          _count: { select: { bankAccounts: true } },
        },
      });
      return {
        plaidItems: items.map((i) => ({
          id: i.id,
          institutionName: i.institutionName,
          status: i.status,
          errorCode: i.errorCode,
          lastSyncAt: i.lastSyncAt?.toISOString() ?? null,
          accountCount: i._count.bankAccounts,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post("/workspaces/:id/plaid-items/:itemId/sync", async (req, reply) => {
    const params = req.params as { id: string; itemId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      await requireProTier(ctx.session.userId);
      const r = await syncTransactions(app.fina.env, ctx.membership.workspaceId, params.itemId);
      // Surface partial-commit counters even on `skipped` so the UI can show
      // "Another refresh is running — got N transactions before yielding."
      return r;
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapPlaidError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.delete("/workspaces/:id/plaid-items/:itemId", async (req, reply) => {
    const params = req.params as { id: string; itemId: string };
    try {
      // INTENTIONAL EXCEPTION to "all Plaid-mutating routes are Pro-gated":
      // disconnect must NOT require Pro tier. If a user's trial expires
      // before they cancel/upgrade, they still need to be able to revoke
      // Plaid's access to their bank — gating that behind the paywall would
      // be a data trap. Owner-only is enforced; tier is not. The README and
      // master spec both note this exception in the same wording.
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      await removeItemStrict(app.fina.env, ctx.membership.workspaceId, params.itemId);
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapPlaidError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });
}
```

- [ ] **Step 4: Register the route in `server.ts`**

```ts
import { plaidItemsRoutes } from "./routes/plaid-items.js";
```

After `await app.register(plaidRoutes);`:

```ts
  await app.register(plaidItemsRoutes);
```

- [ ] **Step 5: Run plaid.routes tests (expect pass)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.routes.test.ts
```

Expected: 14/14 PASS (3 list + 4 sync + 7 disconnect — workspace_mismatch on each, 402 free-owner on sync, 409 `sync_in_progress` race + free-tier-can-disconnect on disconnect).

- [ ] **Step 6: Full suite**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 135/135 (121 prior + 14 new plaid-items routes).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/plaid-items.ts apps/api/src/server.ts apps/api/tests/plaid.routes.test.ts
git commit -m "feat(api): /workspaces/:id/plaid-items list/sync/disconnect (strict + row-level locked)"
```

---

## Task 10: Routes — `routes/accounts.ts` + `routes/transactions.ts` (paginated reads)

**Files:**
- Create: `apps/api/src/routes/accounts.ts`
- Create: `apps/api/src/routes/transactions.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/tests/plaid.routes.test.ts` (append accounts + transactions test blocks)

- [ ] **Step 1: Append failing tests to `plaid.routes.test.ts`**

```ts
// /accounts and /transactions are READ routes — no tier gate (a Free viewer
// in a Pro owner's workspace can still browse what's already there). So
// there's no 402 case to test, only auth + workspace scoping (403 / 404 /
// workspace_mismatch). The existing per-file beforeEach/afterAll from the
// top of the file applies to every describe below.

describe("GET /workspaces/:id/accounts", () => {
  it("members can list accounts including archivedAt", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "oacc@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await connectAItem(app, owner, wsId);

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/accounts`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const list = res.json().accounts;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Checking", type: "depository", mask: "0001" });
    expect(list[0].archivedAt).toBeNull();
    await app.close();
  });

  it("404 for non-member workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "xacc@x.com", name: "X" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/accounts`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "wmacc@x.com", name: "W" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsB}/accounts`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});

describe("GET /workspaces/:id/transactions", () => {

  async function setupItemAndTxs(app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never, n: number) {
    const owner = await signUpAndGetCookie(app, { email: `otx-${Math.random().toString(36).slice(2,6)}@x.com`, name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    plaidMock.itemPublicTokenExchange.push({ data: { access_token: "a", item_id: "i", request_id: "r" } });
    plaidMock.accountsGet.push({
      data: {
        accounts: [
          { account_id: "ac", name: "Checking", official_name: null, mask: "0001", type: "depository", subtype: "checking", balances: { current: 100, available: 100, limit: null, iso_currency_code: "CAD" } },
        ],
        item: { item_id: "i", institution_id: "ins_1" },
        request_id: "r",
      },
    });
    const txs = Array.from({ length: n }, (_, idx) => ({
      transaction_id: `t${idx}`,
      account_id: "ac",
      amount: idx + 0.5,
      date: `2026-05-${String((idx % 28) + 1).padStart(2, "0")}`,
      authorized_date: null,
      authorized_datetime: null,
      datetime: null,
      pending: false,
      pending_transaction_id: null,
      merchant_name: `M${idx}`,
      name: `M${idx}`,
      iso_currency_code: "CAD",
    }));
    plaidMock.transactionsSync.push({ data: { added: txs, modified: [], removed: [], next_cursor: "c", has_more: false } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid/exchange`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ publicToken: "p", institutionId: "ins_1", institutionName: "TB" }),
    });
    return { owner, wsId, plaidItemId: res.json().plaidItemId as string };
  }

  it("default page = 50 sorted occurredAt DESC", async () => {
    const app = await buildApp(env);
    const { owner, wsId } = await setupItemAndTxs(app, 60);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transactions).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
    // Newest first.
    const dates = body.transactions.map((t: { occurredAt: string }) => t.occurredAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    await app.close();
  });

  it("cursor pagination — second page returns the rest", async () => {
    const app = await buildApp(env);
    const { owner, wsId } = await setupItemAndTxs(app, 60);
    const first = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    const cur = first.json().nextCursor as string;
    const second = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?cursor=${encodeURIComponent(cur)}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(second.statusCode).toBe(200);
    const body = second.json();
    expect(body.transactions.length).toBe(10);
    expect(body.nextCursor).toBeNull();
    await app.close();
  });

  it("excludes removed transactions by default", async () => {
    const app = await buildApp(env);
    const { owner, wsId, plaidItemId } = await setupItemAndTxs(app, 3);
    plaidMock.transactionsSync.push({
      data: { added: [], modified: [], removed: [{ transaction_id: "t1" }], next_cursor: "c2", has_more: false },
    });
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/plaid-items/${plaidItemId}/sync`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.json().transactions).toHaveLength(2);
    const include = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?includeRemoved=true`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(include.json().transactions).toHaveLength(3);
    await app.close();
  });

  it("404 for non-member workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "xtx@x.com", name: "X" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/transactions`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 workspace_mismatch — header points to a different workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "wmtx@x.com", name: "W" });
    const wsA = await getOwnerWorkspaceId(u.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsB}/transactions`,
      headers: { cookie: u.cookie, "x-workspace-id": wsA },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});
```

- [ ] **Step 2: Run (expect fail)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.routes.test.ts
```

Expected: only the new accounts/transactions cases FAIL.

- [ ] **Step 3: Implement `apps/api/src/routes/accounts.ts`**

```ts
import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";

export async function accountsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/accounts", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const rows = await prisma.bankAccount.findMany({
        where: { workspaceId: ctx.membership.workspaceId },
        orderBy: { createdAt: "desc" },
      });
      return {
        accounts: rows.map((a) => ({
          id: a.id,
          plaidItemId: a.plaidItemId,
          plaidAccountId: a.plaidAccountId,
          name: a.name,
          officialName: a.officialName,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          currency: a.currency,
          status: a.status,
          balanceCurrent: a.balanceCurrent?.toString() ?? null,
          balanceAvailable: a.balanceAvailable?.toString() ?? null,
          balanceLimit: a.balanceLimit?.toString() ?? null,
          archivedAt: a.archivedAt?.toISOString() ?? null,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 4: Implement `apps/api/src/routes/transactions.ts`**

Cursor pagination uses opaque base64-encoded JSON `{occurredAt, id}` for stable ordering ties.

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";

// `?from`/`?to` arrive as ISO date strings. We validate them as parseable
// dates BEFORE handing them to `new Date(...)` — otherwise an invalid input
// like `?from=foo` would explode at runtime instead of returning 400.
const IsoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be ISO date",
});

// `z.coerce.boolean()` is broken for query strings: `Boolean("false")` is
// truthy, so `?includeRemoved=false` would include them. Parse the raw
// string explicitly.
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
});

type Cursor = { occurredAtMs: number; id: string };
function decodeCursor(s: string | undefined): Cursor | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    if (typeof obj.occurredAtMs === "number" && typeof obj.id === "string") return obj;
  } catch {
    // ignore — treat as no cursor
  }
  return null;
}
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export async function transactionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/transactions", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const q = parsed.data;
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const cursor = decodeCursor(q.cursor);
      const where = {
        workspaceId: ctx.membership.workspaceId,
        ...(q.accountId ? { accountId: q.accountId } : {}),
        ...(q.from ? { occurredAt: { gte: new Date(q.from) } } : {}),
        ...(q.to ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), lte: new Date(q.to) } } : {}),
        ...(q.includeRemoved ? {} : { removedAt: null }),
        ...(cursor
          ? {
              OR: [
                { occurredAt: { lt: new Date(cursor.occurredAtMs) } },
                {
                  AND: [
                    { occurredAt: new Date(cursor.occurredAtMs) },
                    { id: { lt: cursor.id } }, // tie-breaker by id
                  ],
                },
              ],
            }
          : {}),
      };
      const rows = await prisma.transaction.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const hasMore = rows.length > q.limit;
      const page = hasMore ? rows.slice(0, q.limit) : rows;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last
        ? encodeCursor({ occurredAtMs: last.occurredAt.getTime(), id: last.id })
        : null;
      return {
        transactions: page.map((t) => ({
          id: t.id,
          accountId: t.accountId,
          plaidTransactionId: t.plaidTransactionId,
          amount: t.amount.toString(),
          currency: t.currency,
          merchantRaw: t.merchantRaw,
          merchantNormalized: t.merchantNormalized,
          categoryId: t.categoryId,
          occurredAt: t.occurredAt.toISOString(),
          postedAt: t.postedAt?.toISOString() ?? null,
          pending: t.pending,
          source: t.source,
          note: t.note,
          removedAt: t.removedAt?.toISOString() ?? null,
        })),
        nextCursor,
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

- [ ] **Step 5: Register both in `server.ts`**

```ts
import { accountsRoutes } from "./routes/accounts.js";
import { transactionsRoutes } from "./routes/transactions.js";
```

After `await app.register(plaidItemsRoutes);`:

```ts
  await app.register(accountsRoutes);
  await app.register(transactionsRoutes);
```

- [ ] **Step 6: Run tests (expect pass)**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test -- tests/plaid.routes.test.ts
```

Expected: 22/22 PASS in this file (14 prior from Task 9 + 3 accounts + 5 transactions).

- [ ] **Step 7: Full suite**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run api:test
```

Expected: 143/143 (135 prior + 8 new accounts/transactions).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/accounts.ts apps/api/src/routes/transactions.ts apps/api/src/server.ts apps/api/tests/plaid.routes.test.ts
git commit -m "feat(api): /workspaces/:id/{accounts,transactions} read routes (cursor-paginated)"
```

---

## Task 11: Web — `lib/api.ts` `useMe` helper + `useWorkspaceId` hook (small refactor)

**Files:**
- Modify: `apps/web/src/lib/api.ts`

The existing `apiFetch` is fine, but the `/settings/banks` page needs both `tier` (from `/me`) and the active workspace id. Adding two lightweight helpers here keeps the page concise and the hook reuse clear.

- [ ] **Step 1: Add the React import to the existing import block at the top of `apps/web/src/lib/api.ts`**

The file already imports `getActiveWorkspaceId` from `./active-workspace` (Plan 2). Do NOT re-import it. Just add `useEffect, useState` from React at the top of the file:

```ts
import { useEffect, useState } from "react";
```

- [ ] **Step 2: Append the two hooks at the END of the file**

After the existing `bootstrapActiveWorkspace` function:

```ts
export type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};

export function useMe(): { me: Me | null; err: string | null } {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    apiFetch<Me>("/me")
      .then(setMe)
      .catch((e) => setErr((e as { code?: string }).code ?? "error"));
  }, []);
  return { me, err };
}

/**
 * Reconciled active workspace id. Returns null until bootstrap completes.
 */
export function useActiveWorkspaceId(): string | null {
  const [wsId, setWsId] = useState<string | null>(null);
  useEffect(() => {
    bootstrapActiveWorkspace()
      .then((id) => setWsId(id ?? getActiveWorkspaceId()))
      .catch(() => setWsId(null));
  }, []);
  return wsId;
}
```

> **Note:** placing React hooks in `lib/api.ts` couples the file to React. Acceptable here because Next 14 web runtime always has React available and these hooks are tiny convenience wrappers. If we ever want a non-React consumer, lift them to `lib/hooks.ts`.

- [ ] **Step 2: Verify**

```bash
cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: 0 errors. (No tests added — these are tested indirectly by the page in Task 12.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/api.ts
git commit -m "feat(web): useMe + useActiveWorkspaceId hooks for the banks page"
```

---

## Task 12: Web — `/settings/banks` page + 2 components + react-plaid-link

**Files:**
- Modify: `apps/web/package.json` (add `react-plaid-link`)
- Create: `apps/web/src/app/(app)/settings/banks/page.tsx`
- Create: `apps/web/src/app/(app)/settings/banks/_components/connect-bank-button.tsx`
- Create: `apps/web/src/app/(app)/settings/banks/_components/connected-banks-list.tsx`

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter @fina/web add react-plaid-link@^4
```

- [ ] **Step 2: Implement `connect-bank-button.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { apiFetch } from "../../../../../lib/api";

export function ConnectBankButton({
  workspaceId,
  isPro,
  isOwner,
  onConnected,
}: {
  workspaceId: string;
  isPro: boolean;
  isOwner: boolean;
  onConnected: () => void;
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchToken = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ linkToken: string }>(
        `/workspaces/${workspaceId}/plaid/link-token`,
        { method: "POST" },
      );
      setLinkToken(r.linkToken);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      setErr(code === "upgrade_required" ? "Pro tier required to connect a bank." : `Could not start: ${code}`);
    } finally {
      setBusy(false);
    }
  }, [workspaceId]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      try {
        await apiFetch(`/workspaces/${workspaceId}/plaid/exchange`, {
          method: "POST",
          body: JSON.stringify({
            publicToken,
            institutionId: metadata.institution?.institution_id ?? "unknown",
            institutionName: metadata.institution?.name ?? "Unknown bank",
          }),
        });
        onConnected();
        setLinkToken(null);
      } catch (e) {
        setErr(`Could not finalize: ${(e as { code?: string }).code ?? "error"}`);
      }
    },
    onExit: (e) => {
      if (e) setErr(`Exit: ${e.error_code ?? "unknown"}`);
      setLinkToken(null);
    },
  });

  // Open the Plaid Link modal in an effect, NOT during render. Calling
  // `open()` from the render body triggers React's render-during-render
  // warning and double-invokes under StrictMode.
  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  if (!isOwner) {
    return null; // Server enforces owner-only too; this just hides the affordance.
  }

  if (!isPro) {
    return (
      <div style={{ padding: "12px 0" }}>
        <span
          style={{
            display: "inline-block",
            padding: "12px 24px",
            background: "#eee",
            color: "#666",
            borderRadius: 8,
          }}
        >
          Plaid is a Pro feature — upgrade to connect a bank
        </span>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px 0" }}>
      <button
        onClick={fetchToken}
        disabled={busy}
        style={{
          padding: "12px 24px",
          background: "#111",
          color: "#fff",
          borderRadius: 8,
          border: "none",
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy ? "..." : "Connect a bank"}
      </button>
      {err && <p style={{ color: "#c00", marginTop: 8 }}>{err}</p>}
    </div>
  );
}
```

- [ ] **Step 3: Implement `connected-banks-list.tsx`**

```tsx
"use client";

import { useState } from "react";
import { apiFetch } from "../../../../../lib/api";

export type PlaidItemView = {
  id: string;
  institutionName: string;
  status: "active" | "error" | "relink_required";
  errorCode: string | null;
  lastSyncAt: string | null;
  accountCount: number;
};

export function ConnectedBanksList({
  items,
  workspaceId,
  isOwner,
  onChange,
}: {
  items: PlaidItemView[];
  workspaceId: string;
  isOwner: boolean;
  onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh(itemId: string) {
    setBusyId(itemId);
    setMsg(null);
    try {
      const r = await apiFetch<{ added?: number; modified?: number; removed?: number; skipped?: string }>(
        `/workspaces/${workspaceId}/plaid-items/${itemId}/sync`,
        { method: "POST" },
      );
      if (r.skipped === "lock_held") {
        // The per-page tx is the unit of durability, so anything the API
        // reports here was actually committed before we yielded to the
        // racing sync. Surface it instead of dropping the counters.
        const partial = (r.added ?? 0) + (r.modified ?? 0) + (r.removed ?? 0);
        setMsg(
          partial > 0
            ? `Another refresh is running. Got +${r.added ?? 0} / ~${r.modified ?? 0} / -${r.removed ?? 0} before yielding. Try again in a moment.`
            : "Another refresh is already running. Try again in a moment.",
        );
      } else {
        setMsg(`Refreshed: +${r.added ?? 0} added, ${r.modified ?? 0} modified, ${r.removed ?? 0} removed.`);
      }
      onChange();
    } catch (e) {
      setMsg(`Refresh failed: ${(e as { code?: string }).code ?? "error"}`);
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(itemId: string, name: string) {
    if (!window.confirm(`Disconnect "${name}"? Past transactions are kept.`)) return;
    setBusyId(itemId);
    setMsg(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/plaid-items/${itemId}`, { method: "DELETE" });
      setMsg("Disconnected.");
      onChange();
    } catch (e) {
      setMsg(`Disconnect failed: ${(e as { code?: string }).code ?? "error"}`);
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return <p style={{ opacity: 0.6 }}>No banks connected yet.</p>;
  }

  return (
    <div>
      {items.map((it) => (
        <div
          key={it.id}
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 16,
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600 }}>{it.institutionName}</div>
          <div style={{ fontSize: 13, opacity: 0.6, marginTop: 4 }}>
            {it.accountCount} account{it.accountCount === 1 ? "" : "s"}
            {it.lastSyncAt ? ` · last sync ${new Date(it.lastSyncAt).toLocaleString()}` : " · never synced"}
          </div>
          {it.status === "relink_required" && (
            <div style={{ color: "#c00", marginTop: 8, fontSize: 13 }}>
              Reconnect needed (re-auth flow not implemented in this plan).
            </div>
          )}
          {it.status === "error" && (
            <div style={{ color: "#c00", marginTop: 8, fontSize: 13 }}>
              Sync error{it.errorCode ? ` (${it.errorCode})` : ""}.
            </div>
          )}
          {isOwner && (
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button
                onClick={() => refresh(it.id)}
                disabled={busyId === it.id}
                style={{
                  padding: "6px 12px",
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Refresh
              </button>
              <button
                onClick={() => disconnect(it.id, it.institutionName)}
                disabled={busyId === it.id}
                style={{
                  padding: "6px 12px",
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      ))}
      {msg && <p style={{ marginTop: 12, color: "#0a7" }}>{msg}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Implement the page**

`apps/web/src/app/(app)/settings/banks/page.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, useMe, useActiveWorkspaceId } from "../../../../lib/api";
import { ConnectBankButton } from "./_components/connect-bank-button";
import { ConnectedBanksList, type PlaidItemView } from "./_components/connected-banks-list";

type Member = { userId: string; role: "owner" | "editor" | "viewer" };

export default function BanksPage() {
  const wsId = useActiveWorkspaceId();
  const { me, err: meErr } = useMe();
  const [items, setItems] = useState<PlaidItemView[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    setErr(null);
    try {
      const [itemsRes, membersRes] = await Promise.all([
        apiFetch<{ plaidItems: PlaidItemView[] }>(`/workspaces/${wsId}/plaid-items`),
        apiFetch<{ members: Member[] }>(`/workspaces/${wsId}/members`),
      ]);
      setItems(itemsRes.plaidItems);
      setMembers(membersRes.members);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    }
  }, [wsId]);

  useEffect(() => {
    load();
  }, [load]);

  // Errors first — if /me or /plaid-items or /members fails, `me`/`members`
  // stays null but `meErr`/`err` is set. A loading-first check would render
  // "Loading…" forever in that case.
  if (meErr) return <main style={{ padding: 32 }}>Could not load profile: {meErr}</main>;
  if (err) return <main style={{ padding: 32 }}>Could not load banks: {err}</main>;
  if (!wsId || me === null || members === null) return <main style={{ padding: 32 }}>Loading…</main>;

  const isPro = me.tier === "pro";
  // Owner-only for ALL Plaid mutations (link / refresh / disconnect).
  // Server enforces this too; the UI hides the affordances so non-owners
  // don't get rejected mid-action.
  const isOwner = members.find((m) => m.userId === me.user.id)?.role === "owner";

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 32, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Banks</h1>
      <p style={{ opacity: 0.6, marginBottom: 24 }}>
        Connect your bank account so Fina can import your transactions automatically.
      </p>
      <ConnectedBanksList items={items ?? []} workspaceId={wsId} isOwner={isOwner} onChange={load} />
      <div style={{ marginTop: 24 }}>
        <ConnectBankButton workspaceId={wsId} isPro={isPro} isOwner={isOwner} onConnected={load} />
      </div>
      {!isOwner && (
        <p style={{ opacity: 0.6, marginTop: 24, fontSize: 13 }}>
          Only the workspace owner can connect, refresh, or disconnect a bank.
        </p>
      )}
    </main>
  );
}
```

- [ ] **Step 5: Verify typecheck**

```bash
cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/app/'(app)'/settings/banks
git commit -m "feat(web): /settings/banks page (Plaid Link + connected banks list)"
```

---

## Task 13: Web — Banks nav link in `(app)/layout.tsx`

**Files:**
- Modify: `apps/web/src/app/(app)/layout.tsx`

- [ ] **Step 1: Add the link**

Edit `apps/web/src/app/(app)/layout.tsx`. The existing `<nav>` has Home + Workspace links. Add Banks between them:

```tsx
<nav style={{ display: "flex", gap: 16 }}>
  <Link href="/home" style={{ color: "inherit", textDecoration: "none" }}>
    Home
  </Link>
  <Link href="/settings/banks" style={{ color: "inherit", textDecoration: "none" }}>
    Banks
  </Link>
  <Link href="/settings/workspace" style={{ color: "inherit", textDecoration: "none" }}>
    Workspace
  </Link>
</nav>
```

- [ ] **Step 2: Typecheck**

```bash
cd apps/web && pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/'(app)'/layout.tsx
git commit -m "feat(web): Banks nav link in app shell"
```

---

## Task 14: Final verification + README + smoke-test doc Plaid section

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/smoke-tests/2026-05-08-plan-2-workspace-sharing.md`
- (verify only) all of `apps/api`, `apps/web`, `apps/mobile`, `libs/shared`

- [ ] **Step 1: Run full test + typecheck + lint sweep**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm nx run-many -t test
pnpm nx run-many -t typecheck
pnpm nx run-many -t lint
```

Expected: 143 API tests green; typecheck 4/4 green; lint 0 errors. Tests added in Plan 1B: `plaid.crypto` (6), `plaid.tier` (4), `plaid.items` (7), `plaid.sync` (10), `plaid.exchange` (12 — 4 link-token + 8 exchange), `plaid.routes` (22 — 14 list/sync/disconnect + 3 accounts + 5 transactions). Total **+61 tests**, full suite **143** (82 from Plan 2 + 61 from this plan).

- [ ] **Step 2: Append Plaid section to the smoke-test doc**

Edit `docs/superpowers/smoke-tests/2026-05-08-plan-2-workspace-sharing.md`. Append at the very end:

```markdown
---

# Addendum — Plan 1B-foundation: Plaid sandbox flow

## Pre-flight (one-time per machine)

1. Sign up for a Plaid account at https://dashboard.plaid.com/signup → "Sandbox" environment is auto-enabled and free.
2. Copy the **Sandbox** `client_id` and `secret` from the dashboard.
3. Generate an encryption key (32 bytes, base64-encoded):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
4. Add to your shell env (or to a personal `.env.local` you source before `pnpm smoke:api*`):
   ```bash
   export PLAID_CLIENT_ID=...your-client-id...
   export PLAID_SECRET=...your-sandbox-secret...
   export PLAID_ENV=sandbox
   export ENCRYPTION_KEY=...your-32-byte-base64-key...
   ```

## Connect → see transactions

1. `pnpm smoke:db:start` (or confirm `fina-postgres-dev` is up).
2. `pnpm smoke:api` (Terminal A) — must show `Server listening at http://[::1]:4000` with no env errors.
3. `pnpm smoke:web` (Terminal B).
4. Browser → `http://localhost:3100/sign-in` → sign up (gives you a 30-day Pro trial automatically).
5. Click `Banks` in the header nav. Click **Connect a bank**.
6. Plaid Link sandbox modal opens. Pick any institution (e.g. "Tartan Bank"). Use the canned credentials:
   - Username: `user_good`
   - Password: `pass_good`
   - When prompted for MFA, leave the default (`1234`).
7. Select one or more accounts → Continue.
8. The modal closes; the page shows the connected bank with an account count and a recent `last sync`.
9. Verify the data landed via `pnpm smoke:db:studio` (Prisma Studio at `http://localhost:5555`):
   - **plaid_items** has 1 row with `accessTokenCiphertext` (Bytes — opaque) and `accessTokenIv` (12 bytes).
   - **bank_accounts** has rows under that plaid_item, with mask + balance.
   - **transactions** has rows with `merchantRaw`, `amount`, `occurredAt`. Sandbox typically returns ~5-15 per account.

## Manual Refresh

Click **Refresh** on the connected bank card. Toast shows `+0 added, 0 modified, 0 removed` (sandbox doesn't keep generating new transactions). Repeated clicks within the same instant may show "Another refresh is already running" — that's the per-item row-level lock (`SELECT ... FOR UPDATE NOWAIT`) working.

## Disconnect

Click **Disconnect**. Confirm the prompt. The card disappears. In Prisma Studio:
- **plaid_items** row is gone.
- **bank_accounts** row still exists, but `archivedAt` is set and `plaidItemId` is NULL.
- **transactions** rows still exist; their `plaidItemId` is also NULL.

## Free-tier check

Force trial to expire:
```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() - INTERVAL '1 day', \"trialConsumed\" = true WHERE email = 'YOUR_EMAIL';"
```

Reload `/settings/banks`. The Connect button is replaced with **"Plaid is a Pro feature — upgrade to connect a bank"**. Try the API call directly:

```bash
curl -i -X POST http://localhost:4000/workspaces/<wsId>/plaid/link-token \
  -H "x-workspace-id: <wsId>" \
  --cookie "<your session cookie>"
```

→ HTTP 402 `{"error":"upgrade_required"}`.
```

- [ ] **Step 3: Update README Status block**

Edit `README.md`. Replace the Status section with:

```markdown
## Status — 2026-05-11

- ✅ Plan 1 complete: Nx monorepo, Postgres, Fastify API + Better Auth (email/password + magic link), workspace bootstrap with 30-day Pro trial via post-create hook, Expo mobile + Next.js web both rendering /me, CI workflow ready.
- ✅ Plan 2 complete: workspace sharing on web — invites table (hashed bearer tokens, partial-unique-index invariants for one-owner-per-workspace and one-pending-invite-per-email), 9 endpoints, web UI for accept page, /settings/workspace, header switcher. Mobile gets X-Workspace-Id plumbing only.
- ✅ Plan 1B-foundation complete: Plaid integration on web (sandbox) — 4 new schema entities (plaid_items, bank_accounts, transactions, categories), AES-256-GCM token encryption with workspaceId AAD, cursor-based /transactions/sync with per-item row-level lock (`SELECT ... FOR UPDATE NOWAIT`), mutation-during-pagination restart, pending→posted promotion via plaidTransactionId lookup, strict locked disconnect (409 `sync_in_progress` if a refresh races), Pro tier gate on connect/exchange/sync (disconnect is the deliberate exception so trial-expired users can revoke Plaid access), owner-only UI for Connect/Refresh/Disconnect. **API: 143 tests passing.**
- 🚧 Next options: Plan 1B-webhooks (signature verify + idempotency), Plan 1B-categorize (Gemini Flash + merchant normalize), Plan 1B-cron (daily refresh), Plan 1B-mobile (transactions UI). See spec §11.
```

- [ ] **Step 4: Final commit**

```bash
git add README.md docs/superpowers/smoke-tests/2026-05-08-plan-2-workspace-sharing.md
git commit -m "docs: Plan 1B-foundation complete + smoke-test addendum"
```

- [ ] **Step 5: Push (optional, only if user requests)**

```bash
git push origin HEAD
```

---

## Done — Plan 1B-foundation Exit Criteria

- [ ] `pnpm nx run-many -t test` green: 143 API tests across plaid.crypto, plaid.tier, plaid.items, plaid.sync, plaid.exchange, plaid.routes plus the prior Plan 1 + Plan 2 suite.
- [ ] `pnpm nx run-many -t typecheck` green for api / web / mobile / shared.
- [ ] `pnpm nx run-many -t lint` green.
- [ ] CI green on push.
- [ ] **Smoke test:** Pro user signs up → web `/settings/banks` → Plaid Link sandbox (`user_good`/`pass_good`) → DB has plaid_items + bank_accounts + transactions → manual Refresh works → Disconnect leaves bank_accounts (archived) + transactions (history) intact.
- [ ] **Free-tier:** trial-expired user sees "Plaid is a Pro feature" and `/plaid/link-token` returns 402 `upgrade_required`.
- [ ] **Concurrency:** the row-lock unit test in `plaid.sync.test.ts` ("row-lock contention") verifies that `syncTransactions` returns `{skipped:"lock_held"}` when another tx holds `FOR UPDATE` on the row. (Two real parallel `Promise.all` calls don't reliably interleave under JS+Prisma+mocked Plaid, so we model the production race — sync vs. disconnect / sync vs. cron — directly.)
- [ ] **Pending → posted:** sandbox can't easily simulate this, but the unit test `tests/plaid.sync.test.ts` covers it (`plaidTransactionId` lookup + `removedAt: null` restoration).
- [ ] **Disconnect Plaid failure:** unit test verifies the local row is preserved + 502 returned.
- [ ] **Initial-sync partial failure:** unit test verifies item is durable + response carries `syncOk: false`.
- [ ] **Encryption boundary:** `readAccessToken(env, wsId, plaidItemId)` rejects mismatched `(workspaceId, plaidItemId)` pairs (covered directly in `plaid.items.test.ts` — "404 when workspaceId doesn't match the item's workspace").
- [ ] **Plaid error sanitization:** no `access_token`-bearing string ever appears in API logs (`grep access_test apps/api logs` after a smoke test should return nothing).
