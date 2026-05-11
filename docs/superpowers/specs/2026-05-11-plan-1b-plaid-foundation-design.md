# Plan 1B-foundation — Plaid Integration (Web) — Design Spec

**Date:** 2026-05-11
**Status:** Brainstorm complete, ready for implementation planning
**Owner:** Brian (cwsbrian@gmail.com)
**Implements:** master spec `docs/superpowers/specs/2026-05-07-fina-design.md` §8 (data model — Plaid entities), §9 (Plaid sync model), §15 Phase 1B — but **scoped to "foundation only"** (see Scope below).

---

## 1. Goal

Pro-tier user on **web** clicks "Connect a bank", completes the Plaid Link sandbox flow, and ends up with `plaid_items` + `accounts` + `transactions` rows in the DB. Manual "Refresh" re-runs `/transactions/sync` from the stored cursor. Disconnect removes the item but keeps transactions for history. Free-tier users hit a `402 upgrade_required` when they try.

This is the foundation: schema + Plaid client + cursor-based sync + tier gate + web UI for connecting/refreshing/disconnecting. Webhooks, cron, LLM categorization, and mobile UI are deferred to follow-up plans (see §11).

**Smoke-test exit criterion:** in browser, sign up → trial gives Pro → `/settings/banks` → Connect → sandbox `user_good`/`pass_good` → see Plaid items + accounts + transactions land in DB (verify via `pnpm smoke:db:studio`). Manual Refresh advances the cursor. Disconnect removes the item but keeps transactions.

---

## 2. Scope

**In:**
- New schema: `plaid_items`, `accounts`, `transactions`, `categories` (last is empty — created now so the FK lands cleanly).
- One partial **unique** index plus one partial **non-unique** index, both written as raw SQL because Prisma can't express partial indexes natively: a `UNIQUE (workspaceId, plaidTransactionId) WHERE plaidTransactionId IS NOT NULL` for dedupe, and a non-unique `(workspaceId, occurredAt DESC) WHERE categoryId IS NULL AND removedAt IS NULL` to support the categorize plan's "uncategorized list" query.
- Plaid Node SDK wrapper (`@plaid/plaid-node`).
- Plaid Link UI on **web only** (`react-plaid-link` in `/settings/banks`).
- AES-256-GCM encryption of `access_token` at rest, with `aad = workspaceId` so a swapped row can't be decrypted.
- `/transactions/sync` cursor-based loop (master spec §9.2), with a **per-item Postgres row-level lock** (`SELECT ... FOR UPDATE NOWAIT` on `plaid_items` inside each page-tx) so concurrent manual refreshes can't both apply the same page (originally drafted as `pg_try_advisory_xact_lock`, but that lock releases at commit and would let two concurrent refreshes both read the same cursor — caught in plan review). Disconnect takes the same row lock before its Plaid call.
- Pending → posted promotion (the posted row's `pending_transaction_id` field tells us the old pending row's `transaction_id` — we look up by `plaidTransactionId == t.pending_transaction_id`, update in place, and clear `removedAt` if the pending row was already soft-removed in an earlier page; never insert a duplicate row).
- Removed transaction soft delete (`removedAt` timestamp).
- Tier gate: `requireProTier(userId)` — Pro (trial or future paid) only. Free → `402 upgrade_required`.
- API endpoints: link-token, exchange, list, sync, disconnect, accounts (read), transactions (paginated read).
- Web UI: `/settings/banks` page with "Connect", "Refresh", "Disconnect" + connected-banks list. Header nav link.
- Test suite: AES-GCM round-trip, tier gate, exchange + initial sync, sync edge cases (pending→posted, modified, removed, lock contention), all routes including auth/role/Pro gate failures.

**Out (deferred to later plans, see §11):**
- Webhooks (signature verification, `webhook_code`-based dedupe, `audit_events` row per webhook).
- Daily cron sync via `pg-boss` (master spec §9.5).
- LLM categorization (Gemini Flash) + merchant normalization + `merchant_mappings` learning.
- Item re-auth UX (status is captured in `plaid_items.status`; no banner/notification surfaced yet).
- Mobile UI of any kind (Plaid Link, transactions list, categorize).
- Manual transaction entry / CSV import.
- Auto-created "Cash" account for users with no Plaid item.
- Lite-tier 1-Item gating (no `subscriptions` table yet — flat Pro-or-Free).
- Plaid `development`/`production` environment hardening (sandbox only here; env var supports later promotion without code change).

---

## 3. Data Model

Four new Prisma models added to `apps/api/prisma/schema.prisma`. Workspace gets four new relation fields.

```prisma
model PlaidItem {
  id                       String      @id @default(cuid())
  workspaceId              String
  // AES-256-GCM. AAD = workspaceId so a row swapped between workspaces won't decrypt.
  accessTokenCiphertext    Bytes       // [encrypted | 16-byte auth tag]
  accessTokenIv            Bytes       // 12 bytes
  itemId                   String      @unique  // Plaid's item_id — second exchange of same bank → P2002
  institutionId            String
  institutionName          String
  status                   PlaidItemStatus @default(active)
  errorCode                String?     // captured from sync exceptions; surfaced in UI later
  lastSyncAt               DateTime?
  lastCursor               String?     // /transactions/sync cursor; null until first sync completes
  createdAt                DateTime    @default(now())
  updatedAt                DateTime    @updatedAt

  workspace                Workspace   @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  accounts                 Account[]
  transactions             Transaction[]

  @@index([workspaceId])
  @@map("plaid_items")
}

enum PlaidItemStatus { active error relink_required }

model Account {
  id                  String        @id @default(cuid())
  workspaceId         String
  plaidItemId         String?       // null reserved for future manual ("Cash") accounts
  plaidAccountId      String?       @unique
  name                String
  officialName        String?
  mask                String?
  type                String        // depository / credit / loan / ...
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
  // SetNull on disconnect — accounts (and their transactions) outlive the
  // PlaidItem so historical data stays coherent. Disconnect handler also
  // sets `archivedAt` so UI can hide them.
  plaidItem           PlaidItem?    @relation(fields: [plaidItemId], references: [id], onDelete: SetNull)
  transactions        Transaction[]

  @@index([workspaceId, plaidItemId])
  @@map("accounts")
}

enum AccountStatus { active closed hidden }

model Transaction {
  id                          String             @id @default(cuid())
  workspaceId                 String
  accountId                   String
  plaidItemId                 String?            // SetNull on disconnect — transactions outlive the item
  plaidTransactionId          String?            // current Plaid id; changes when pending→posted
  plaidPendingTransactionId   String?            // pending id Plaid forwards; we use it to find the row to promote
  amount                      Decimal            @db.Decimal(14, 2)  // Plaid convention: + = expense, - = income/refund
  currency                    String             @default("CAD")
  merchantRaw                 String
  merchantNormalized          String?            // populated in categorize plan
  categoryId                  String?            // populated in categorize plan; nullable now
  occurredAt                  DateTime
  postedAt                    DateTime?
  pending                     Boolean            @default(false)
  source                      TransactionSource  @default(plaid)
  rawData                     Json
  note                        String?
  removedAt                   DateTime?          // soft delete (Plaid `removed`)
  createdAt                   DateTime           @default(now())
  updatedAt                   DateTime           @updatedAt

  workspace                   Workspace          @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  account                     Account            @relation(fields: [accountId], references: [id], onDelete: Cascade)
  plaidItem                   PlaidItem?         @relation(fields: [plaidItemId], references: [id], onDelete: SetNull)
  // FK to categories. Nullable now (categorize plan populates).
  category                    Category?          @relation(fields: [categoryId], references: [id], onDelete: SetNull)

  @@index([workspaceId, occurredAt(sort: Desc)])
  @@index([workspaceId, accountId, occurredAt(sort: Desc)])
  // Per master spec §8 — the categorize plan needs this for "by category" reads.
  @@index([workspaceId, categoryId])
  @@map("transactions")
}

enum TransactionSource { plaid manual csv }

model Category {
  // Empty in 1B-foundation. Created so transactions.categoryId FK lands now,
  // saving a future migration when categorize plan begins populating rules.
  id          String     @id @default(cuid())
  workspaceId String
  name        String
  parentId    String?
  icon        String?
  color       String?
  archivedAt  DateTime?
  createdAt   DateTime   @default(now())

  workspace    Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  parent       Category?     @relation("CategoryTree", fields: [parentId], references: [id])
  children     Category[]    @relation("CategoryTree")
  transactions Transaction[]

  @@unique([workspaceId, name])
  @@map("categories")
}
```

Workspace gets: `plaidItems PlaidItem[]`, `accounts Account[]`, `transactions Transaction[]`, `categories Category[]`.

**Manual SQL appended to the migration** (Prisma can't express partial indexes natively — only the first is `UNIQUE`, the second is a regular partial index):

```sql
-- Per master spec §8: same Plaid transaction never duplicated within a workspace.
-- Manual transactions have NULL here, so we can't put a single full UNIQUE.
CREATE UNIQUE INDEX "transactions_one_per_plaid_id_per_workspace"
  ON "transactions" ("workspaceId", "plaidTransactionId")
  WHERE "plaidTransactionId" IS NOT NULL;

-- For the categorize plan's "uncategorized list" daily UX query.
-- Defined now so the categorize plan doesn't need its own migration.
CREATE INDEX "transactions_uncategorized"
  ON "transactions" ("workspaceId", "occurredAt" DESC)
  WHERE "categoryId" IS NULL AND "removedAt" IS NULL;
```

Design choices, all from master spec §8/§9:

- `transactions.amount` follows Plaid convention (+ = expense, − = income). UI uses abs + color.
- **Both** `Transaction.plaidItemId` AND `Account.plaidItemId` cascade **SetNull** (not Cascade) on PlaidItem delete — disconnect keeps transactions AND accounts as history. Disconnect handler additionally sets `accounts.archivedAt = now()` so UI can hide them. Earlier draft had Account cascade from PlaidItem, which would have transitively destroyed transactions via `transactions.account` Cascade — caught in spec review.
- `rawData JSONB` preserves Plaid's full payload — future fields (e.g., enriched merchant data) usable without a migration.
- `Category` rows left empty (categorize plan populates), but the FK is wired now via `Transaction.category` so the categorize plan doesn't need a separate migration.
- **Plaid date mapping into our schema** (the implementation must follow this so analytics aren't off by a day or two):
  - `occurredAt` ← `t.authorized_datetime ?? t.authorized_date ?? t.datetime ?? t.date` (when the user actually transacted; `authorized_*` is closer to "swiped the card")
  - `postedAt` ← `t.datetime ?? t.date` only when `t.pending === false` (when the bank settled)
  - `pending` ← `t.pending`

---

## 4. API Endpoints

All workspace-scoped routes go through `requireWorkspaceContext` (Plan 2 helper). Pro-gated routes additionally call `requireProTier(session.userId)`.

All routes are namespaced under `/workspaces/:id/...` (matching Plan 2's convention; the path id is cross-checked against the `X-Workspace-Id` header inside `requireWorkspaceContext` to catch confused-deputy attempts). All Plaid-**mutating** routes are **owner-only**, and Pro-gated against the requesting user for `link-token`, `exchange`, and `sync` — this avoids the asymmetry caught in spec review where a viewer could initiate `link-token` but not finish `exchange`, or where post-transfer the old Pro owner could still refresh as a viewer while the new Free owner couldn't. **Disconnect (`DELETE /plaid-items/:itemId`) is the deliberate exception:** owner-only but NOT Pro-gated, so a user whose trial expires can still revoke Plaid's access to their bank rather than being trapped behind the paywall. Read routes are members-only and not tier-gated, so a Free viewer in a Pro owner's workspace can still browse what's already there.

| Method | Path | Membership | Tier | Body / Notes |
|---|---|---|---|---|
| `POST` | `/workspaces/:id/plaid/link-token` | **owner** | **Pro** | No body. Server calls `/link/token/create` with `client_user_id = userId`, products `[transactions]`, country `[CA]`. Returns `{linkToken, expiration}`. |
| `POST` | `/workspaces/:id/plaid/exchange` | **owner** | **Pro** | Body `{publicToken, institutionId, institutionName}`. Exchange + accounts/get + initial sync. See §7 for the partial-failure contract. Returns `{plaidItemId, accountCount, transactionCount, syncOk}`. |
| `GET` | `/workspaces/:id/plaid-items` | viewer | — | `[{id, institutionName, status, lastSyncAt, accountCount, errorCode}]`. |
| `POST` | `/workspaces/:id/plaid-items/:itemId/sync` | **owner** | **Pro** | Manual incremental sync. Returns `{added, modified, removed}`, or `{skipped:"lock_held", added, modified, removed}` if another sync holds the per-item row lock — counters reflect any pages this sync committed before yielding (per-page tx is the unit of durability). |
| `DELETE` | `/workspaces/:id/plaid-items/:itemId` | **owner** | — | Strict: Plaid `/item/remove` MUST succeed (or return already-removed) before the local row is deleted. If it fails, the row + encrypted token are retained and the route returns 502 `plaid_unavailable` so the caller can retry. Also takes the same row-level lock as sync (`SELECT ... FOR UPDATE NOWAIT` on `plaid_items`), so it can't race a refresh — returns 409 `sync_in_progress` if held. See §7 disconnect block. |
| `GET` | `/workspaces/:id/accounts` | viewer | — | `[{id, plaidItemId, name, mask, type, balanceCurrent, archivedAt, ...}]`. |
| `GET` | `/workspaces/:id/transactions` | viewer | — | Cursor-paginated. Default 50/page sorted `occurredAt DESC`. Filters: `accountId`, `from`, `to`, `includeRemoved` (default false). |

**Existing routes affected:**
- `routes/me.ts` — currently has its own `effectiveTier()`. Move to shared `auth/tier.ts` so `requireProTier` and `/me` use one source of truth. No behavior change.

**HTTP error mapping (additions to existing `mapInviteError`-style mappers):**

| Code | HTTP | Where |
|---|---|---|
| `upgrade_required` | 402 | `requireProTier` failure |
| `already_connected` | 422 | Same Plaid `item_id` already stored (P2002 on `plaid_items.itemId` UNIQUE). Note: relinking the same bank account through Plaid Link returns a **new** `item_id`, so this only fires on retry of the same exchange, not on the user re-linking the same bank. |
| `plaid_link_expired` | 410 | Exchange called with stale public_token (Plaid returns `INVALID_PUBLIC_TOKEN`) |
| `plaid_login_required` | **409** | Item entered `relink_required` mid-sync; UI prompts re-link. Status is intentionally NOT 401 — 401 already means "no session" in this codebase (`auth/context.ts`) and overloading it would confuse clients into logging the user out. |
| `plaid_unavailable` | 502 | Network or 5xx from Plaid; also the response when strict disconnect couldn't reach Plaid. |

---

## 5. Encryption (AES-256-GCM)

New helper at `apps/api/src/crypto/aes-gcm.ts`. Pure Node `crypto` — no external dependency.

```ts
const ALG = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export function encrypt(env, plaintext, aad): { ciphertext: Buffer; iv: Buffer } {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, getKey(env), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  // Tag is appended to the ciphertext for storage simplicity.
  return { ciphertext: Buffer.concat([enc, cipher.getAuthTag()]), iv };
}
export function decrypt(env, ciphertext, iv, aad): string { /* mirror, verify tag */ }
```

**Key sourcing:** `ENCRYPTION_KEY` env var, base64-encoded 32 random bytes. Validated at startup (`zod.string()` + custom check on length post-decode). Cached after first decode.

**AAD (Additional Authenticated Data):** every encrypt/decrypt passes `workspaceId` as AAD. Implication: an attacker who somehow swaps the `accessTokenCiphertext` of workspace A onto workspace B's row gets a decryption *failure*, not a successful decrypt. Defense in depth on top of the application's own workspace-scope checks.

**Key rotation:** out of scope here. Documented in plan as a future concern (would need ciphertext versioning + re-encrypt job).

**Where the raw token lives:**
- Receives once: in the `/plaid/exchange` handler's response from Plaid.
- Encrypts immediately: in `plaid/items.ts.storeAccessToken(env, workspaceId, plaidItemId, raw)` (only this one function constructs new rows).
- Reads via: `plaid/items.ts.readAccessToken(env, workspaceId, plaidItemId)` — **takes BOTH workspaceId AND plaidItemId** and verifies the pair before decrypting, per master spec §10.1 hard rule #4 ("Plaid call functions take `(workspace_id, plaid_item_id)` two args, verify ownership inside"). AAD on its own only catches a swapped ciphertext blob; the wrapper guarantees you cannot read another workspace's token even via a direct service call.
- **Plaid error sanitization** before logging or returning: Plaid SDK errors can include the access_token or other PII in their `error.config` / `error.request` payloads. The Plaid client wrapper strips these (allowlist: `error_code`, `error_type`, `error_message`, `request_id`, HTTP status) before any `app.log.error(...)` call or response body, and routes only ever return the allowlisted fields.
- Never logged. Never returned in any API response. Never persisted unencrypted.

---

## 6. Tier Gate

New helper at `apps/api/src/auth/tier.ts`:

```ts
export type TierResolution = { tier: Tier; trialActive: boolean; trialEndsAt: Date | null };

export async function effectiveTier(userId: string): Promise<TierResolution> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.trialEndsAt && user.trialEndsAt > new Date()) {
    return { tier: "pro", trialActive: true, trialEndsAt: user.trialEndsAt };
  }
  // Future: read `subscriptions` for paid Pro/Lite. Not in this plan.
  return { tier: "free", trialActive: false, trialEndsAt: user.trialEndsAt };
}

export async function requireProTier(userId: string): Promise<void> {
  const { tier } = await effectiveTier(userId);
  if (tier !== "pro") {
    throw new HttpError(402, "upgrade_required", `Pro tier required (current: ${tier})`);
  }
}
```

`routes/me.ts` is refactored to import `effectiveTier` from here (delete the local copy).

---

## 7. Sync Flow

### `/plaid/exchange` handler (with partial-failure contract)

```
0. requireWorkspaceContext (owner) + requireProTier
1. plaid /item/public_token/exchange       → { accessToken, itemId }
2. plaid /accounts/get(accessToken)         → accounts[]
3. prisma.$transaction(serializable):
     a. encrypt(accessToken, aad = workspaceId)
     b. plaidItem.create({ ...encrypted, itemId, institutionId, institutionName })
        — P2002 on itemId → throw "already_connected" (mapped to 422)
     c. account.createMany(...)
4. Initial syncTransactions(workspaceId, plaidItemId) outside the create tx.
   On failure, the item + accounts are KEPT; the route still returns 200 with
   syncOk: false so the UI shows the item in `error` state and the user can
   manually Refresh. On success, syncOk: true.
5. Return { plaidItemId, accountCount, transactionCount, syncOk }.
   transactionCount is 0 when syncOk: false.
```

**Why split:** if the sync threw inside the same transaction as the item create, the user would re-click Connect and hit `already_connected` on every retry, with no way out. Splitting means the connect itself is durable; sync failures are recoverable by Refresh.

**Soft request timeout:** the route caps `syncTransactions` with a Promise race against a 30s deadline so a slow sandbox response doesn't tie up the Fastify worker indefinitely. On timeout, item is left in `error` state with `errorCode = "sync_timeout"`; user retries via Refresh.

### `syncTransactions(workspaceId, plaidItemId)` — implements master spec §9.2

**Two-transaction structure** so error/relink_required status writes survive a Plaid failure:

```ts
async function syncTransactions(env, workspaceId, plaidItemId): Promise<SyncResult> {
  // ---- Outer setup tx: acquire lock + read item ------------------------
  const setup = await prisma.$transaction(async (tx) => {
    const lockKey = advisoryLockKey(plaidItemId);  // see "Advisory lock key" below
    const got = await tx.$queryRaw<{ got: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${lockKey}) AS got
    `;
    if (!got[0].got) return { skipped: "lock_held" as const };

    const item = await tx.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
    if (item.workspaceId !== workspaceId) throw new HttpError(404, "not_found");
    return { skipped: false as const, item };
  });

  if (setup.skipped === "lock_held") {
    return { skipped: "lock_held", added: 0, modified: 0, removed: 0 };
  }

  const accessToken = readAccessToken(env, workspaceId, plaidItemId); // verifies pair
  const originalCursor = setup.item.lastCursor ?? undefined;
  let cursor = originalCursor;
  let added = 0, modified = 0, removed = 0;

  try {
    while (true) {
      const res = await plaidClient(env).transactionsSync({
        access_token: accessToken, cursor,
      });

      // Plaid contract: if the item mutates mid-pagination, the loop MUST
      // restart from the ORIGINAL cursor (not from the last page's
      // next_cursor). Their error code is TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION.
      // We catch the equivalent flag (`mutated_during_sync` in some SDK
      // versions, the error code in others), reset accumulators, and restart.
      if (res.data.mutated_during_sync) {
        cursor = originalCursor;
        added = modified = removed = 0;
        continue;
      }

      // ---- Inner data tx (per page) ----
      await prisma.$transaction(async (tx) => {
        for (const t of res.data.added)    { await upsertAdded(tx, t, setup.item); added++; }
        for (const t of res.data.modified) { await upsertModified(tx, t, setup.item); modified++; }
        for (const t of res.data.removed)  { await markRemoved(tx, t.transaction_id, workspaceId); removed++; }
        await tx.plaidItem.update({
          where: { id: plaidItemId },
          data: {
            lastCursor: res.data.next_cursor,
            lastSyncAt: new Date(),
            status: "active",
            errorCode: null,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

      cursor = res.data.next_cursor;
      if (!res.data.has_more) break;
    }
    return { added, modified, removed };
  } catch (e) {
    // ---- Separate short tx to persist status. The error from this point
    // ---- on must not roll back the page commits we already made. ----
    await prisma.$transaction(async (tx) => {
      const next = isPlaidErrorCode(e, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION")
        ? null // not really an error here — but in case it leaks out of the loop guard
        : isPlaidErrorCode(e, "ITEM_LOGIN_REQUIRED")
          ? { status: "relink_required" as const, errorCode: "ITEM_LOGIN_REQUIRED" }
          : isPlaidApiError(e)
            ? { status: "error" as const, errorCode: (e.error_code ?? "unknown") }
            : { status: "error" as const, errorCode: "internal" };
      if (next) {
        await tx.plaidItem.update({ where: { id: plaidItemId }, data: next });
      }
    });
    throw mapPlaidError(e); // 409 plaid_login_required | 502 plaid_unavailable | rethrow
  }
}
```

**Why pages are committed separately, not all in one tx:** Plaid's `/transactions/sync` is page-at-a-time, and the cursor advances per page. If we wrapped everything in a single transaction and failed on page 3, we'd lose the work from pages 1-2 AND the user would re-fetch the same rows next sync (the cursor write would also be rolled back). Per-page commits give us forward progress under failures. The advisory lock outside the page loop is what keeps two refreshes from racing.

### Advisory lock key

`pg_try_advisory_xact_lock` takes either one 64-bit `bigint` or two 32-bit ints. We use the one-bigint form with a deterministic mapping:

```ts
function advisoryLockKey(plaidItemId: string): bigint {
  // SHA-256 first 8 bytes interpreted as big-endian signed 64-bit int. SHA-256
  // collision probability across all plaid_item rows in our DB is negligible.
  // SIGNED bigint because Postgres advisory locks reject unsigned values that
  // exceed 2^63-1; using the signed interpretation keeps us within range.
  const h = crypto.createHash("sha256").update(plaidItemId).digest();
  return h.readBigInt64BE(0);
}
```

### `upsertAdded` — pending → posted promotion (CORRECTED lookup key)

When Plaid posts a previously-pending transaction, the new `added` entry carries:
- a **new** `transaction_id`
- a `pending_transaction_id` pointing at the **old pending row's `transaction_id`**

So the promotion lookup is `plaidTransactionId == t.pending_transaction_id` — NOT `plaidPendingTransactionId == t.pending_transaction_id` as an earlier draft of this spec said.

Additionally: Plaid does not guarantee that the pending row's `removed` entry and the posted row's `added` entry land on the same page. If the pending row was already soft-removed (its `removedAt` set) and then we receive the `added` for the posted row pointing back at it, we must promote in place AND clear `removedAt`. Otherwise the transaction stays hidden from `GET /transactions`.

```ts
async function upsertAdded(tx, t, item) {
  // Promotion path: a previously-pending row that's now posting.
  if (t.pending_transaction_id) {
    const promotion = await tx.transaction.findFirst({
      where: {
        workspaceId: item.workspaceId,
        plaidTransactionId: t.pending_transaction_id, // old pending's tx_id
      },
    });
    if (promotion) {
      await tx.transaction.update({
        where: { id: promotion.id },
        data: {
          plaidTransactionId: t.transaction_id,           // new posted id
          plaidPendingTransactionId: t.pending_transaction_id, // record for audit
          pending: false,
          occurredAt: plaidOccurredAt(t),
          postedAt: plaidPostedAt(t),
          amount: t.amount,
          merchantRaw: t.merchant_name ?? t.name,
          rawData: t,
          removedAt: null, // restore if the pending row was removed earlier this sync
        },
      });
      return;
    }
  }

  // Fresh-insert path. We can't use prisma.transaction.upsert with our
  // partial unique index (Prisma can't model partial unique constraints).
  // Implementation does `try { create } catch P2002 { update by partial-unique }`
  // — detail goes in the plan; the contract here is "idempotent under retry".
  await idempotentCreateTransaction(tx, t, item);
}

function plaidOccurredAt(t): Date {
  return new Date(t.authorized_datetime ?? t.authorized_date ?? t.datetime ?? t.date);
}
function plaidPostedAt(t): Date | null {
  if (t.pending) return null;
  return new Date(t.datetime ?? t.date);
}
```

(Implementation note: the Prisma-friendly fresh-insert form is `findFirst → if missing create else update; catch P2002 → fall back to update`. Detail goes in the plan, not here.)

### Disconnect — strict + locked

```
0. requireWorkspaceContext (owner)
1. Acquire the SAME advisory lock as sync (`pg_try_advisory_xact_lock`). If
   not granted, return 409 "sync_in_progress" so caller retries after a moment.
2. Read item, decrypt access_token via readAccessToken(env, workspaceId, plaidItemId).
3. plaid /item/remove(accessToken).
     - 200 → continue
     - "ITEM_NOT_FOUND" / already-removed → treat as success, continue
     - Any other error → 502 "plaid_unavailable", DO NOT delete the local row
4. prisma.$transaction:
     a. update accounts set archivedAt = now() where plaidItemId = X
        (status is unchanged so existing transactions/queries still resolve)
     b. delete plaid_item — accounts.plaidItemId becomes NULL via SetNull,
        transactions stay; their plaidItemId also becomes NULL.
5. Return 204.
```

Strict ordering (Plaid first, DB second) means a partial failure on step 3 leaves the user able to retry rather than orphaning a Plaid Item we can no longer remove.

### `markRemoved` — soft delete

```ts
await tx.transaction.updateMany({
  where: { workspaceId, plaidTransactionId, removedAt: null },
  data: { removedAt: new Date() },
});
```

Master spec §9.3: "hard delete 금지." Removed transactions stay queryable for audit / forecasting carve-outs.

---

## 8. Concurrency Story

| Race | Defense |
|---|---|
| Two manual Refreshes at the same time on the same item | `pg_try_advisory_xact_lock(advisoryLockKey(plaidItemId))` taken in the **setup tx** of `syncTransactions`. Second call sees `got = false` → returns `{skipped: "lock_held"}` immediately, no cursor regression. |
| Disconnect during sync (or vice versa) | Disconnect takes the **same** advisory lock as sync, in the same key space. Whichever wins, the other returns "lock_held" / "sync_in_progress" instead of operating on a half-deleted item. |
| Webhook retry duplicating the same `transaction_id` (deferred plan, but schema is ready) | Partial unique `(workspaceId, plaidTransactionId) WHERE plaidTransactionId IS NOT NULL` — second insert hits P2002, caught and treated as update (idempotent). |
| Pending row + posted row in the same `added` batch (or across pages) | `upsertAdded` looks up by `plaidTransactionId == t.pending_transaction_id` first — promotion in place precedes the fresh-insert path. Cross-page case where the pending row was already soft-removed: promotion clears `removedAt: null`. |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` mid-loop (Plaid item updates while we're paginating) | Loop guard: if `res.data.mutated_during_sync` (or the equivalent error code) is set, reset accumulators, reset `cursor` to `originalCursor`, restart the page loop. Each page commits separately so the work isn't lost across the restart of the un-applied tail. |
| Same `access_token` exchanged twice (browser retry of the same exchange request) | `plaid_items.itemId` UNIQUE — second `prisma.plaidItem.create` hits P2002 → mapped to 422 `already_connected`. **Note:** the user re-linking the SAME bank through Plaid Link results in a NEW `item_id` from Plaid, so this index does NOT prevent multiple items per bank per workspace; it only dedupes exchange retries of the same Item. |
| Initial sync inside `/exchange` fails | Item + accounts already committed (separate tx). Response carries `syncOk: false`. UI surfaces the item in `error` state; user retries via Refresh. The item is durable (no orphan), no `already_connected` confusion on retry. |

---

## 9. Web UI (`/settings/banks`)

One new route, two sub-components, one nav link. All client components.

```
apps/web/src/app/(app)/settings/banks/page.tsx
apps/web/src/app/(app)/settings/banks/_components/connect-bank-button.tsx
apps/web/src/app/(app)/settings/banks/_components/connected-banks-list.tsx
```

Plus a `Banks` link in the existing `(app)/layout.tsx` header nav.

### `page.tsx` (data flow)

1. On mount, `apiFetch<{plaidItems: PlaidItemView[]}>('/workspaces/:id/plaid-items')` (where `:id` comes from active workspace cookie/state).
2. Render `<ConnectedBanksList>` for the existing items (with Refresh + Disconnect actions, calling `onChange` to refetch).
3. Render `<ConnectBankButton>` for the empty state OR as a "+ Add another bank" button beneath the list.
4. Owner-only check: only render `ConnectBankButton` if the current user has `role === "owner"` in the active workspace (read from the same `/workspaces/:id/members` endpoint Plan 2 added).

### `ConnectBankButton`

```tsx
const { data, isLoading } = useLinkToken();          // POST /plaid/link-token on click
const { open, ready } = usePlaidLink({
  token: data?.linkToken,
  onSuccess: async (publicToken, metadata) => {
    await apiFetch(`/workspaces/${wsId}/plaid/exchange`, { method: 'POST', body: JSON.stringify({
      publicToken,
      institutionId: metadata.institution.institution_id,
      institutionName: metadata.institution.name,
    })});
    onConnected();  // refetch list
  },
  onExit: (err) => err && setError(err),
});

return <button onClick={() => open()} disabled={!ready}>Connect a bank</button>;
```

For **Free tier**, the button copy is "Plaid is a Pro feature — upgrade to connect" and is non-interactive (anchor styled to look like a button, but no `usePlaidLink` setup at all). Pro check is done client-side from `/me`'s `tier` field; the server `requireProTier` is the real gate.

### `ConnectedBanksList`

```tsx
{items.map(it => (
  <Card key={it.id}>
    <Header>{it.institutionName}</Header>
    <Meta>{it.accountCount} accounts · last sync {timeAgo(it.lastSyncAt)}</Meta>
    {it.status === "relink_required" && <Warning>Reconnect needed</Warning>}
    <Actions>
      <Button onClick={() => refresh(it.id)}>Refresh</Button>
      <Button onClick={() => disconnect(it.id)}>Disconnect</Button>
    </Actions>
  </Card>
))}
```

`refresh` calls `POST /workspaces/:id/plaid-items/:itemId/sync` and toasts the `{added, modified, removed}` summary. `disconnect` does `window.confirm` + `DELETE`.

### Dependency

```
pnpm --filter @fina/web add react-plaid-link@~3.5
```

(react-plaid-link 3.x is the current stable line, ESM-friendly.)

---

## 10. Testing

### API (vitest, mock Plaid SDK)

The Plaid SDK is mocked via `vi.mock("plaid", ...)` returning a controllable fake `PlaidApi`. We never hit Plaid's network during tests — sandbox is for manual smoke-test only. The mock supports prescripted responses for: `linkTokenCreate`, `itemPublicTokenExchange`, `accountsGet`, `transactionsSync` (with `added`/`modified`/`removed`/`has_more`/`next_cursor`), `itemRemove`.

```
plaid.crypto.test.ts     // AES-GCM round-trip
                         // AAD mismatch fails verify (defense-in-depth)
                         // key length validation rejects wrong size
                         // readAccessToken rejects wrong (workspaceId, plaidItemId) pair (master spec §10.1)
plaid.tier.test.ts       // requireProTier: trial-active → pass, expired → 402, free → 402, no user → throws
plaid.exchange.test.ts   // happy: rows persisted + initial sync ran (syncOk: true)
                         // P2002 on itemId → 422 already_connected
                         // Plaid INVALID_PUBLIC_TOKEN → 410 plaid_link_expired
                         // initial-sync partial failure: item kept + 200 with syncOk: false
                         // route owner-only + Pro gate
plaid.sync.test.ts       // happy multi-page: cursor advances, all 3 buckets applied
                         // pending → posted promotion via plaidTransactionId lookup
                         // promotion clears removedAt when pending was soft-removed earlier (cross-page case)
                         // modified updates in place
                         // removed sets removedAt
                         // ITEM_LOGIN_REQUIRED → status = relink_required PERSISTED (separate tx) + 409 plaid_login_required
                         // generic Plaid error → status = error + 502 plaid_unavailable
                         // mutation-during-pagination → loop restarts from originalCursor, accumulators reset
                         // advisory lock contention: parallel calls — exactly one returns skipped, other does work
plaid.routes.test.ts     // link-token (owner only / viewer 403 / Pro yes / Free 402)
                         // exchange (owner only / viewer 403 / Pro gate)
                         // list (members read / non-member 404)
                         // sync route (owner only, Pro gate, lock_held passthrough)
                         // accounts list (member read, archivedAt visible)
                         // transactions list (pagination, filters, includeRemoved)
                         // disconnect strict: Plaid /item/remove called first, accounts archived, transactions kept
                         // disconnect Plaid failure: 502 plaid_unavailable, local row preserved for retry
                         // disconnect-vs-sync lock contention: one returns 409 sync_in_progress
                         // workspace_mismatch (path id != header id) → 400
```

Estimated +40–50 tests. Suite total ~120–130.

### Web

Manual smoke-test only for the Plaid Link iframe (Plaid's modal isn't trivially automatable). Components covered indirectly by `apiFetch` typing + spec compliance review.

### Smoke-test addendum

Add a new section to `docs/superpowers/smoke-tests/2026-05-08-plan-2-workspace-sharing.md` (or a new doc) covering the Plaid sandbox flow: `user_good`/`pass_good`, expected institution count, where to look for transactions in Prisma Studio.

---

## 11. Out of scope — follow-up plans

- **1B-webhooks:** signature verification (`plaid-verification` header), `webhook_code`-based dedupe table, audit_events row per webhook, real `INITIAL_UPDATE`/`DEFAULT_UPDATE` handling. Replaces "manual refresh after exchange" with webhook-driven freshness.
- **1B-cron:** `pg-boss` daily job iterating active `plaid_items` whose `lastSyncAt < now() - 24h` (or NULL) and re-running `syncTransactions`. Master spec §9.5.
- **1B-categorize:** Gemini Flash batch categorization, merchant normalization rules (`WALMART #1234 BC` → `Walmart`), `merchant_mappings` table, learning loop on manual confirms.
- **1B-mobile:** mobile transactions list + categorize UI; consume the existing `/workspaces/:id/transactions` endpoint; nothing new server-side.
- **1B-reauth:** UI banner on `relink_required` items; `Plaid /link/token/create` with `access_token` for re-auth flow.
- **Lite tier 1-Item gating:** waits on the billing/`subscriptions` plan.

---

## 12. New env vars

| Name | Required? | Purpose |
|---|---|---|
| `PLAID_CLIENT_ID` | yes (api) | Plaid app client id |
| `PLAID_SECRET` | yes (api) | Plaid app secret (env-specific) |
| `PLAID_ENV` | default `sandbox` | `sandbox` / `development` / `production` |
| `ENCRYPTION_KEY` | yes (api) | base64-encoded 32 random bytes for AES-256-GCM |

Updates needed in: `apps/api/src/env.ts`, `.env.example`, `.env.test` (deterministic test value), repo-root `.env` (user fills their sandbox keys), all `pnpm smoke:api*` scripts (don't hardcode secrets — pass through if shell-set).

---

## 13. Plan structure (sketch — concrete plan goes in `docs/superpowers/plans/2026-05-11-plan-1b-plaid-foundation.md`)

~14 tasks, target order:

1. Schema + migration (4 tables + 1 partial UNIQUE index + 1 partial non-unique index + the new Category FK).
2. Env vars + `ENCRYPTION_KEY` validation; `.env.test` and smoke-script env updates.
3. AES-GCM helper + unit tests (round-trip, AAD mismatch, key length).
4. `requireProTier` + `effectiveTier` consolidation; `/me` refactor + tests.
5. Plaid client wrapper + sanitized error path + fake/mock for tests.
6. `plaid/items.ts` service: `storeAccessToken(env, wsId, plaidItemId, raw)`, `readAccessToken(env, wsId, plaidItemId)` (verifies pair), `removeItem(env, wsId, plaidItemId)` (strict).
7. `syncTransactions` — advisory-lock setup tx, per-page data tx, separate status-persist tx, mutation-during-pagination restart, error mapping + tests (largest task).
8. `upsertAdded` (pending→posted via `plaidTransactionId` lookup + `removedAt: null` restore), `upsertModified`, `markRemoved` + tests.
9. `routes/plaid.ts` — `POST /workspaces/:id/plaid/link-token` + `POST /workspaces/:id/plaid/exchange` (with partial-failure contract: item durable, sync may fail, `syncOk` flag) + tests.
10. `routes/plaid-items.ts` — list / sync / disconnect + tests.
11. `routes/accounts.ts` + `routes/transactions.ts` (paginated) + tests.
12. Web `/settings/banks` page + 2 components + react-plaid-link integration.
13. `Banks` nav link in `(app)/layout.tsx` + Free-tier upgrade copy.
14. Final verification (full suite + typecheck + lint) + README + smoke-test doc Plaid section.
