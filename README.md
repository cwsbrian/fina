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

## Status — 2026-05-08

- ✅ Plan 1 complete: Nx monorepo, Postgres, Fastify API + Better Auth (email/password + magic link), workspace bootstrap with 30-day Pro trial via post-create hook, Expo mobile + Next.js web both rendering /me, CI workflow ready. **API: 13 tests passing.**
- 🚧 Next: Plan 2 — workspace sharing (invites + roles + switcher).
