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

## Status — 2026-05-11

- ✅ Plan 1 complete: Nx monorepo, Postgres, Fastify API + Better Auth (email/password + magic link), workspace bootstrap with 30-day Pro trial via post-create hook, Expo mobile + Next.js web both rendering /me, CI workflow ready.
- ✅ Plan 2 complete: workspace sharing on web — invites table (hashed bearer tokens, partial-unique-index invariants for one-owner-per-workspace and one-pending-invite-per-email), 9 endpoints, web UI for accept page, /settings/workspace, header switcher. Mobile gets X-Workspace-Id plumbing only.
- ✅ Plan 1B-foundation complete: Plaid integration on web (sandbox) — 4 new schema entities (plaid_items, bank_accounts, transactions, categories), AES-256-GCM token encryption with workspaceId AAD, cursor-based /transactions/sync with per-item row-level lock (`SELECT ... FOR UPDATE NOWAIT`), mutation-during-pagination restart, pending→posted promotion via plaidTransactionId lookup, strict locked disconnect (409 `sync_in_progress` if a refresh races), Pro tier gate on connect/exchange/sync (disconnect is the deliberate exception so trial-expired users can revoke Plaid access), owner-only UI for Connect/Refresh/Disconnect. **API: 146 tests passing.**
- ✅ Plan 1B-categorize complete: auto transaction categorization (backend) — MerchantMapping table + categorizationSource enum, 11 English category seed (case-insensitive partial unique), loop-until-stable merchant normalizer, Gemini 2.5 Flash Lite via @google/genai with structured JSON output, mapping-first + LLM-fallback service with race-safe guards, syncTransactions returns newTxIds (exchange detaches, manual sync awaits), categories CRUD + manual categorize with merchant_mapping upsert + back-fill. **API: 199 tests passing.**
- ✅ Plan 1B-webhooks complete: Plaid webhook handler — POST /plaid/webhook with ES256 JWT verify (jose, JWK cache respecting expired_at, iat 5min window), plaid_webhook_events audit table (no body-hash dedup; sync's cursor + row-level lock handles duplicates), detached sync+categorize dispatch, lock_held leaves processedAt NULL for cron retry, PlaidItem.webhookUrl with linkTokenCreate registration + startup backfill for items connected before this feature, PLAID_WEBHOOK_URL optional env var. **API: 226 tests passing.**
- 🚧 Next options: Plan 1B-cron (daily refresh + webhook event TTL cleanup + lock_held retry), Plan 1B-mobile (transactions UI). See spec §11.
