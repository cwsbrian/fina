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
- Two manual partial unique indexes: `transactions(workspaceId, plaidTransactionId) WHERE plaidTransactionId IS NOT NULL`; `transactions_uncategorized` partial filter index for the future "uncategorized" daily query.
- Plaid Node SDK wrapper (`@plaid/plaid-node`).
- Plaid Link UI on **web only** (`react-plaid-link` in `/settings/banks`).
- AES-256-GCM encryption of `access_token` at rest, with `aad = workspaceId` so a swapped row can't be decrypted.
- `/transactions/sync` cursor-based loop (master spec §9.2), with **Postgres advisory lock per item** so concurrent manual refreshes don't regress the cursor.
- Pending → posted promotion (look up by `plaidPendingTransactionId`, update in place — never insert a duplicate row).
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
  plaidItem           PlaidItem?    @relation(fields: [plaidItemId], references: [id], onDelete: Cascade)
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

  @@index([workspaceId, occurredAt(sort: Desc)])
  @@index([workspaceId, accountId, occurredAt(sort: Desc)])
  @@index([workspaceId, plaidPendingTransactionId])
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

  workspace   Workspace  @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  parent      Category?  @relation("CategoryTree", fields: [parentId], references: [id])
  children    Category[] @relation("CategoryTree")

  @@unique([workspaceId, name])
  @@map("categories")
}
```

Workspace gets: `plaidItems PlaidItem[]`, `accounts Account[]`, `transactions Transaction[]`, `categories Category[]`.

**Manual SQL appended to the migration** (Prisma can't express partial indexes natively):

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
- `Transaction.plaidItemId` cascades **SetNull** (not Cascade) on PlaidItem delete — disconnect keeps transactions as history.
- `Account` cascades from PlaidItem (the rows have no value without the item).
- `rawData JSONB` preserves Plaid's full payload — future fields (e.g., enriched merchant data) usable without a migration.
- `Category` left empty intentionally; populated in the categorize plan.

---

## 4. API Endpoints

All workspace-scoped routes go through `requireWorkspaceContext` (Plan 2 helper). Pro-gated routes additionally call `requireProTier(session.userId)`.

| Method | Path | Membership | Tier | Body / Notes |
|---|---|---|---|---|
| `POST` | `/plaid/link-token` | viewer + workspace ctx | **Pro** | No body. Server calls `/link/token/create` with `client_user_id = userId`, products `[transactions]`, country `[CA]`. Returns `{linkToken, expiration}`. |
| `POST` | `/plaid/exchange` | **owner** + workspace ctx | **Pro** | Body `{publicToken, institutionId, institutionName}`. Exchange + accounts/get + initial sync (synchronous). Returns `{plaidItemId, accountCount, transactionCount}`. |
| `GET` | `/workspaces/:id/plaid-items` | viewer | — | `[{id, institutionName, status, lastSyncAt, accountCount, errorCode}]`. |
| `POST` | `/workspaces/:id/plaid-items/:itemId/sync` | viewer | **Pro** | Manual incremental sync. Returns `{added, modified, removed}`. If lock contended, `{skipped: "lock_held", added: 0, modified: 0, removed: 0}`. |
| `DELETE` | `/workspaces/:id/plaid-items/:itemId` | **owner** | — | Calls Plaid `/item/remove` (best-effort), then `prisma.plaidItem.delete()`. Cascade drops accounts; transactions kept (plaidItemId → NULL). |
| `GET` | `/workspaces/:id/accounts` | viewer | — | `[{id, plaidItemId, name, mask, type, balanceCurrent, ...}]`. |
| `GET` | `/workspaces/:id/transactions` | viewer | — | Cursor-paginated. Default 50/page sorted `occurredAt DESC`. Filters: `accountId`, `from`, `to`, `includeRemoved` (default false). |

**Why is sync gated to Pro for viewers?** Pro tier is a per-user attribute (the trial belongs to the trial-starter). A workspace shared with a viewer who happens to be Free-tier can still refresh, because the `access_token` belongs to the owner — not the viewer. Tier gate fires on whoever is *requesting*, but the relevant tier is the workspace owner's. Practical resolution: the **owner**'s tier governs Plaid availability for the workspace. We keep `requireProTier` on the requesting user for now (simplest), and accept that a Free viewer in a Pro owner's workspace can't trigger sync. They'll see existing data via `GET` endpoints (no Pro gate). When billing matures, this becomes "workspace tier" instead of "user tier."

**Existing routes affected:**
- `routes/me.ts` — currently has its own `effectiveTier()`. Move to shared `auth/tier.ts` so `requireProTier` and `/me` use one source of truth. No behavior change.

**HTTP error mapping (additions to existing `mapInviteError`-style mappers):**

| Code | HTTP | Where |
|---|---|---|
| `upgrade_required` | 402 | `requireProTier` failure |
| `already_connected` | 422 | Plaid item with same `itemId` already exists for ANY workspace this user owns (P2002 on `itemId`) |
| `plaid_link_expired` | 410 | Exchange called with stale public_token (Plaid returns `INVALID_PUBLIC_TOKEN`) |
| `plaid_login_required` | 401 (custom code) | Item entered `relink_required` mid-sync; returned to client so UI can prompt re-link |
| `plaid_unavailable` | 502 | Network or 5xx from Plaid |

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
- Encrypts immediately: in `plaid/items.ts.storeAccessToken()` (only this one function constructs new rows).
- Reads via: `plaid/items.ts.readAccessToken(plaidItemId)` (looks up + decrypts; only the `syncTransactions` and the Plaid item-remove path call this).
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

### `/plaid/exchange` handler (synchronous initial sync)

```
0. requireWorkspaceContext (owner) + requireProTier
1. plaid /item/public_token/exchange       → { accessToken, itemId }
2. plaid /accounts/get(accessToken)         → accounts[]
3. prisma.$transaction(serializable):
     a. encrypt(accessToken, aad = workspaceId)
     b. plaidItem.create({ ...encrypted, itemId, institutionId, institutionName })
        — P2002 on itemId → throw "already_connected" (mapped to 422)
     c. account.createMany(...)
4. syncTransactions(workspaceId, plaidItemId)
5. return { plaidItemId, accountCount, transactionCount }
```

Initial sync runs **inside the request handler** — keeps the smoke-test "see transactions immediately after Connect" simple. Plaid's sandbox returns ~5–10 transactions per account, so the request takes a couple seconds. Production-scale items would benefit from a background job (deferred to webhook plan).

### `syncTransactions(workspaceId, plaidItemId)` — implements master spec §9.2

```ts
return prisma.$transaction(async (tx) => {
  // Per-item advisory lock prevents concurrent syncs from regressing the cursor.
  const lockKey = sha1AsBigInt(plaidItemId);
  const got = await tx.$queryRaw<{ got: boolean }[]>`SELECT pg_try_advisory_xact_lock(${lockKey}) AS got`;
  if (!got[0].got) {
    return { skipped: "lock_held", added: 0, modified: 0, removed: 0 };
  }

  const item = await tx.plaidItem.findUniqueOrThrow({ where: { id: plaidItemId } });
  if (item.workspaceId !== workspaceId) throw new HttpError(404, "not_found");

  const accessToken = decrypt(env, item.accessTokenCiphertext, item.accessTokenIv, workspaceId);
  let cursor = item.lastCursor ?? undefined;
  let added = 0, modified = 0, removed = 0;

  try {
    while (true) {
      const res = await plaidClient(env).transactionsSync({ access_token: accessToken, cursor });
      for (const t of res.data.added)    { await upsertAdded(tx, t, item);    added++;    }
      for (const t of res.data.modified) { await upsertModified(tx, t, item); modified++; }
      for (const t of res.data.removed)  { await markRemoved(tx, t.transaction_id, item.workspaceId); removed++; }
      await tx.plaidItem.update({
        where: { id: plaidItemId },
        data: { lastCursor: res.data.next_cursor, lastSyncAt: new Date(),
                status: "active", errorCode: null },
      });
      cursor = res.data.next_cursor;
      if (!res.data.has_more) break;
    }
    return { added, modified, removed };
  } catch (e) {
    // Capture status without aborting the entire DB write
    if (isPlaidErrorCode(e, "ITEM_LOGIN_REQUIRED")) {
      await tx.plaidItem.update({
        where: { id: plaidItemId },
        data: { status: "relink_required", errorCode: e.error_code },
      });
    } else if (isPlaidApiError(e)) {
      await tx.plaidItem.update({
        where: { id: plaidItemId },
        data: { status: "error", errorCode: e.error_code ?? "unknown" },
      });
    }
    throw e;
  }
}, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
```

### `upsertAdded` — pending → posted promotion

When Plaid posts a previously-pending transaction, the new `added` entry has a different `transaction_id` AND a `pending_transaction_id` pointing at the old pending row. We promote in place rather than insert a duplicate:

```ts
async function upsertAdded(tx, t, item) {
  if (t.pending_transaction_id) {
    const promotion = await tx.transaction.findFirst({
      where: { workspaceId: item.workspaceId,
               plaidPendingTransactionId: t.pending_transaction_id },
    });
    if (promotion) {
      await tx.transaction.update({
        where: { id: promotion.id },
        data: {
          plaidTransactionId: t.transaction_id,
          pending: false,
          postedAt: new Date(t.date),
          amount: t.amount,
          merchantRaw: t.merchant_name ?? t.name,
          rawData: t,
        },
      });
      return;
    }
  }
  // Otherwise insert idempotently — the partial unique index handles webhook replay.
  await tx.transaction.upsert({
    where: { /* by partial unique on (workspaceId, plaidTransactionId) — Prisma can't model this directly,
              so the implementation uses a findFirst + create + catch P2002 fallback */ },
    create: { /* full row */ },
    update: { /* idempotent same-data */ },
  });
}
```

(Implementation note: the Prisma-friendly form is `findFirst → if missing create else update; catch P2002 → try again`. Detail goes in the plan, not here.)

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
| Two manual Refreshes at the same time on the same item | `pg_try_advisory_xact_lock` per `plaid_item_id` — second returns `{skipped: "lock_held"}` immediately, no cursor regression. |
| Webhook retry duplicating the same `transaction_id` (deferred plan, but schema is ready) | Partial unique `(workspaceId, plaidTransactionId) WHERE plaidTransactionId IS NOT NULL` — second insert hits P2002, caught and treated as no-op. |
| Pending row + posted row arrive in the same sync batch | `upsertAdded` looks up by `plaidPendingTransactionId` first — promotion path takes precedence over insert path. |
| Same `access_token` exchanged twice (user clicks Connect on the same bank again) | `plaid_items.itemId` UNIQUE — second `prisma.plaidItem.create` hits P2002 → mapped to 422 `already_connected`. |
| Disconnect during sync | Cascade-delete during the `$transaction` shouldn't conflict with the running sync (different transaction). Worst case the running sync's final cursor write fails because the row is gone — caught and logged. |

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
    await apiFetch('/plaid/exchange', { method: 'POST', body: JSON.stringify({
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
plaid.crypto.test.ts     // AES-GCM round-trip, AAD mismatch fails verify, key length validation
plaid.tier.test.ts       // requireProTier: trial-active → pass, expired → 402, free → 402
plaid.exchange.test.ts   // happy: rows persisted + initial sync ran
                         // P2002 on itemId → 422 already_connected
                         // Plaid INVALID_PUBLIC_TOKEN → 410 plaid_link_expired
plaid.sync.test.ts       // happy multi-page: cursor advances, all 3 buckets applied
                         // pending → posted promotion via plaidPendingTransactionId
                         // modified updates in place
                         // removed sets removedAt
                         // ITEM_LOGIN_REQUIRED → status = relink_required + error rethrown
                         // advisory lock contention: two parallel calls → exactly one returns skipped
plaid.routes.test.ts     // link-token (Pro yes / Free 402)
                         // exchange (owner only / viewer 403 / Pro gate)
                         // list (members read / non-member 404)
                         // sync route (Pro gate, lock_held passthrough)
                         // accounts list (member read)
                         // transactions list (pagination, filters, includeRemoved)
                         // disconnect (owner only, Plaid /item/remove called, transactions kept)
```

Estimated +30–40 tests. Suite total ~110–120.

### Web

Manual smoke-test only for the Plaid Link iframe (Plaid's modal isn't trivially automatable). Components covered indirectly by `apiFetch` typing + spec compliance review.

### Smoke-test addendum

Add a new section to `docs/superpowers/smoke-tests/2026-05-08-plan-2-workspace-sharing.md` (or a new doc) covering the Plaid sandbox flow: `user_good`/`pass_good`, expected institution count, where to look for transactions in Prisma Studio.

---

## 11. Out of scope — follow-up plans

- **1B-webhooks:** signature verification (`plaid-verification` header), `webhook_code`-based dedupe table, audit_events row per webhook, real `INITIAL_UPDATE`/`DEFAULT_UPDATE` handling. Replaces "manual refresh after exchange" with webhook-driven freshness.
- **1B-cron:** `pg-boss` daily job iterating active `plaid_items` where `lastSyncAt > 24h ago` and re-running `syncTransactions`. Master spec §9.5.
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

1. Schema + migration (4 tables + 2 partial unique indexes).
2. Env vars + `ENCRYPTION_KEY` validation; `.env.test` and smoke-script env updates.
3. AES-GCM helper + unit tests.
4. `requireProTier` + `effectiveTier` consolidation; `/me` refactor + tests.
5. Plaid client wrapper + fake/mock for tests.
6. `plaid/items.ts` service: `storeAccessToken`, `readAccessToken`, `disconnect`.
7. `syncTransactions` with advisory lock + error mapping + tests (the largest task).
8. `upsertAdded` (pending→posted), `upsertModified`, `markRemoved` + tests.
9. `routes/plaid.ts` — link-token + exchange (with synchronous initial sync) + tests.
10. `routes/plaid-items.ts` — list / sync / disconnect + tests.
11. `routes/accounts.ts` + `routes/transactions.ts` (paginated) + tests.
12. Web `/settings/banks` page + 2 components + react-plaid-link integration.
13. `Banks` nav link in `(app)/layout.tsx` + Free-tier upgrade copy.
14. Final verification (full suite + typecheck + lint) + README + smoke-test doc Plaid section.
