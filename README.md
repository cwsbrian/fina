# Fina

AI Financial Advisor (chat-first). See `docs/superpowers/specs/2026-05-07-fina-design.md`.

## Dev Setup

Requires Node 20.18+, pnpm 9.12+, Docker.

```bash
nvm use
pnpm install
docker compose up -d
cp .env.example .env       # fill in BETTER_AUTH_SECRET, GOOGLE_*, RESEND_API_KEY
pnpm nx run api:db:migrate
pnpm nx run-many -t dev --projects=api,mobile,web --parallel=3
```

## Workspaces

- `apps/api` — Fastify backend with Better Auth mounted at `/api/auth`
- `apps/mobile` — Expo React Native app
- `apps/web` — Next.js (App Router)
- `libs/shared` — shared TypeScript types

## Mobile Deploy

Run mobile deploy commands from `apps/mobile`.

### iOS TestFlight / App Store

App Store Connect uploads currently require Xcode 26 or later with the iOS 26
SDK. Before building locally, confirm:

```bash
xcodebuild -version
xcode-select -p
sudo xcodebuild -runFirstLaunch
```

Build a production IPA locally:

```bash
cd /Users/brianchoi/Documents/work/personal/fina/apps/mobile
mkdir -p ../../dist

pnpm dlx eas-cli@latest build \
  --platform ios \
  --profile production \
  --local \
  --output ../../dist/fina-ios-production.ipa
```

Upload the IPA to App Store Connect:

```bash
cd /Users/brianchoi/Documents/work/personal/fina/apps/mobile

EXPO_NO_KEYCHAIN=1 pnpm dlx eas-cli@latest submit \
  --platform ios \
  --profile production \
  --path ../../dist/fina-ios-production-v15.ipa
```

If Apple login fails with a macOS Keychain error such as `Security returned a
non-successful error code: 36`, clear the stale App Store Connect session and
disable Keychain for the next EAS command:

```bash
rm -rf ~/.app-store/auth/cwsbrian@gmail.com

EXPO_NO_KEYCHAIN=1 pnpm dlx eas-cli@latest build \
  --platform ios \
  --profile production \
  --local \
  --output ../../dist/fina-ios-production.ipa
```

After upload, wait for processing in App Store Connect, then add the build to
TestFlight internal testing. For the first iOS subscription submission, make
sure the app version page includes the subscriptions under **In-App Purchases
and Subscriptions** before submitting for review.

## Database

Postgres 16 runs in a local Docker container (`docker-compose.yml`). Data is persisted in the
`fina_fina-postgres` Docker volume — survives container restarts; only `docker compose down -v`
deletes it.

**Connection:**
- Host: `localhost:5432`
- User: `fina` / Password: `fina`
- Databases: `fina` (dev), `fina_test` (vitest, auto-created via `scripts/init-db.sh`)

**Where DB lives by environment:**

| Env | Location |
|---|---|
| Local dev | Docker `fina-postgres` container |
| CI | Postgres service container in `.github/workflows/ci.yml` |
| Production (v1 deploy) | Managed Postgres (Render / Neon / Supabase / Railway — TBD at deploy) |

**Common commands:**

```bash
docker compose up -d                                       # start
docker compose down                                        # stop (data preserved)
docker compose down -v                                     # stop + DELETE all data
docker compose logs -f postgres                            # logs
docker compose exec postgres psql -U fina -d fina          # interactive SQL
docker compose exec postgres psql -U fina -d fina -c "\dt" # list tables
pnpm --filter @fina/api db:studio                          # Prisma Studio GUI
pnpm --filter @fina/api db:migrate                         # apply schema changes (dev)
pnpm --filter @fina/api db:deploy                          # apply migrations (prod-style, no prompts)
```

### Viewing the data

Three options — pick the one that fits the moment:

**1. Prisma Studio (GUI, recommended for casual viewing)**

```bash
pnpm --filter @fina/api db:studio
```

Opens `http://localhost:5555` in your browser. Click tables, view rows, follow relations,
edit/delete inline. Recognizes our schema (enums, FKs).

**2. Terminal psql (fast, dev debugging)**

```bash
docker compose exec postgres psql -U fina -d fina
```

Useful one-liners:
```sql
\dt                              -- list tables
\d users                         -- describe users table
SELECT * FROM users;
SELECT * FROM workspaces;
SELECT * FROM memberships;
SELECT * FROM sessions;          -- active sessions
\q                               -- exit
```

**3. External GUI (TablePlus / DBeaver / pgAdmin)**

Connect to `localhost:5432`, user `fina`, password `fina`, database `fina`. Use this for
larger explorations, ER diagrams, or managing multiple environments side-by-side.

## Stripe local setup (billing)

1. Sign up at https://dashboard.stripe.com/register (free).
2. In **Developers → API keys**, copy the test-mode Secret key into
   `STRIPE_SECRET_KEY` (`sk_test_...`).
3. **Products** → New product (do both):
   - "Fina Pro" — recurring **$7.00 CAD / month** → copy price ID into
     `STRIPE_PRICE_PRO_MONTHLY`.
   - "Fina Max" — recurring **$15.00 CAD / month** → copy price ID into
     `STRIPE_PRICE_MAX_MONTHLY`.
4. **Settings → Billing → Customer portal** → **Activate**. Enable: cancel
   subscription, update payment method, view invoices, allow switching
   between Pro and Max.
5. Forward webhooks to your local API (in a separate terminal):
   ```bash
   stripe listen --forward-to localhost:4000/webhooks/stripe
   ```
   Copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`. In **Developers
   → Webhooks**, confirm the endpoint's "API version" is `2025-02-24.acacia`
   or later — older versions emit payloads with different field shapes that
   our handler doesn't parse.
6. Restart the API so the new env values load (`pnpm smoke:api`).
7. Visit `http://localhost:3100/settings/plan`, click Upgrade. Use Stripe's
   test card `4242 4242 4242 4242`, any future expiry, any CVC, any postal.


## Reset Test User
fina-admin-reset-iap-test-user tester@test.com

## Status — 2026-05-11

- ✅ Plan 1 complete: Nx monorepo, Postgres, Fastify API + Better Auth (email/password + magic link), workspace bootstrap with 30-day Pro trial via post-create hook, Expo mobile + Next.js web both rendering /me, CI workflow ready.
- ✅ Plan 2 complete: workspace sharing on web — invites table (hashed bearer tokens, partial-unique-index invariants for one-owner-per-workspace and one-pending-invite-per-email), 9 endpoints, web UI for accept page, /settings/workspace, header switcher. Mobile gets X-Workspace-Id plumbing only.
- ✅ Plan 1B-foundation complete: Plaid integration on web (sandbox) — 4 new schema entities (plaid_items, bank_accounts, transactions, categories), AES-256-GCM token encryption with workspaceId AAD, cursor-based /transactions/sync with per-item row-level lock (`SELECT ... FOR UPDATE NOWAIT`), mutation-during-pagination restart, pending→posted promotion via plaidTransactionId lookup, strict locked disconnect (409 `sync_in_progress` if a refresh races), Pro tier gate on connect/exchange/sync (disconnect is the deliberate exception so trial-expired users can revoke Plaid access), owner-only UI for Connect/Refresh/Disconnect. **API: 146 tests passing.**
- ✅ Plan 1B-categorize complete: auto transaction categorization (backend) — MerchantMapping table + categorizationSource enum, 11 English category seed (case-insensitive partial unique), loop-until-stable merchant normalizer, DeepSeek V4 Flash with structured JSON output, mapping-first + LLM-fallback service with race-safe guards, syncTransactions returns newTxIds (exchange detaches, manual sync awaits), categories CRUD + manual categorize with merchant_mapping upsert + back-fill. **API: 199 tests passing.**
- ✅ Plan 1B-webhooks complete: Plaid webhook handler — POST /plaid/webhook with ES256 JWT verify (jose, JWK cache respecting expired_at, iat 5min window), plaid_webhook_events audit table (no body-hash dedup; sync's cursor + row-level lock handles duplicates), detached sync+categorize dispatch, lock_held leaves processedAt NULL for cron retry, PlaidItem.webhookUrl with linkTokenCreate registration + startup backfill for items connected before this feature, PLAID_WEBHOOK_URL optional env var. **API: 226 tests passing.**
- 🚧 Next options: Plan 1B-cron (daily refresh + webhook event TTL cleanup + lock_held retry), Plan 1B-mobile (transactions UI). See spec §11.
