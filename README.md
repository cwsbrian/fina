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

## Status — 2026-05-08

- ✅ Plan 1 complete: Nx monorepo, Postgres, Fastify API + Better Auth (email/password + magic link), workspace bootstrap with 30-day Pro trial via post-create hook, Expo mobile + Next.js web both rendering /me, CI workflow ready. **API: 13 tests passing.**
- 🚧 Next: Plan 2 — workspace sharing (invites + roles + switcher).
