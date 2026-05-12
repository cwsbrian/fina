# Plan 2 — Workspace Sharing (Web) Smoke Test

End-to-end manual verification for the implementation in `docs/superpowers/plans/2026-05-08-plan-2-workspace-sharing.md`.

This guide assumes Plan 2 is implemented but **not yet committed**. All commands below are run from the repo root unless noted.

---

## Environment notes (this machine)

- The host already has another Postgres on port **5432** → Plan 2 dev container runs on **5433**.
- The host already has another web app on port **3000** → Plan 2 web dev runs on **3100**.
  - The two API allowlists (`apps/api/src/auth.ts` Better Auth `trustedOrigins` and `apps/api/src/server.ts` CORS `origin`) include **both** `http://localhost:3000` and `http://localhost:3100` in dev — additive change so other projects on 3000 also keep working.
- The repo-root `.env` is owned by root and points at port 5432. Rather than edit it, every command below sets the relevant env vars inline.
- Next.js loads `.env*` from the Next project directory (`apps/web`), NOT the repo root. The repo `.env`'s `NEXT_PUBLIC_API_URL` is therefore invisible to web. Either inline-export it (preferred for one-off smoke testing) OR create `apps/web/.env.local`. Both options are shown below.

## 0. Pre-flight

```bash
# Postgres dev container should already be up; verify:
docker ps --filter name=fina-postgres-dev --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
# Expected: Up X hours, 0.0.0.0:5433->5432/tcp

# If it's missing, start it (uses the same image + init script as docker-compose.yml):
docker run -d --name fina-postgres-dev --restart unless-stopped \
  -p 5433:5432 \
  -e POSTGRES_USER=fina -e POSTGRES_PASSWORD=fina -e POSTGRES_DB=fina \
  -v "$(pwd)/scripts/init-db.sh:/docker-entrypoint-initdb.d/init-db.sh:ro" \
  postgres:16-alpine
# Then apply migrations to both DBs:
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api db:deploy
```

## 1. API server (Terminal 1)

```bash
cd /home/cwsbr/personal/fina
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
WEB_APP_URL=http://localhost:3100 \
pnpm nx run api:dev
```

**Expected:** `Server listening at http://[::1]:4000`. Leave running. Invite emails in dev mode (no `RESEND_API_KEY`) print to this console as `[dev email] to=…` lines — that's where you'll grab the invite token URL in step 3.

### Accessing the web app from another device (Tailscale, LAN, etc.)

If you load the web app from a non-localhost origin (e.g. `http://100.65.93.102:3100` on your phone), you have to do **more than just allow the origin in CORS** — the browser also enforces SameSite cookie rules.

**The pitfall:** Better Auth sets the session cookie as `SameSite=Lax`. Lax cookies are NOT sent on cross-**site** fetches (different host counts as a different site, even on different ports of the same machine). So if web is on `100.65.93.102:3100` and API is on `localhost:4000`, sign-in succeeds but every subsequent API call is anonymous → `Could not reach API: unauthenticated` on `/home`.

**The fix:** put web AND API on the same host (different ports is fine — that's same-site, just cross-origin, which CORS handles). Set `BETTER_AUTH_URL` and `NEXT_PUBLIC_API_URL` to the IP-based URLs so the cookie is bound to the right domain and web fetches the matching host.

**Terminal 1 — API:**

```bash
cd /home/cwsbr/personal/fina
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
WEB_APP_URL=http://100.65.93.102:3100 \
BETTER_AUTH_URL=http://100.65.93.102:4000 \
DEV_ORIGINS=http://100.65.93.102:3100 \
pnpm nx run api:dev
```

**Terminal 2 — Web:**

```bash
cd /home/cwsbr/personal/fina/apps/web
NEXT_PUBLIC_API_URL=http://100.65.93.102:4000 \
  pnpm exec next dev -p 3100 -H 0.0.0.0
```

`-H 0.0.0.0` is required — Next dev defaults to listening on `localhost` only, which is unreachable from another device.

**Browser:**

- **Clear cookies for both `localhost` and the IP first** — stale cookies from earlier localhost sessions cause confusing 401s. Easiest: incognito window.
- Hit `http://100.65.93.102:3100/sign-in`.

Notes:
- Multiple origins: `DEV_ORIGINS=http://100.65.93.102:3100,http://192.168.1.50:3100`.
- `WEB_APP_URL` is the base of the invite-email link — invitees on the same network/Tailnet need it to match what they can reach.
- Production allowlists are empty for both `DEV_ORIGINS` and `trustedOrigins` defaults — they only take effect when `NODE_ENV !== "production"`.
- For HTTPS smoke tests, use `tailscale serve` or a reverse proxy. The above HTTP setup only works because the same-host condition lets `SameSite=Lax` through; if you go truly cross-site, you'd need `SameSite=None; Secure` cookies which require HTTPS.

## 2. Web server (Terminal 2)

The Nx `web:dev` target is hardcoded to port 3000. For port 3100, invoke `next` directly. Pick ONE of the two options below.

### Option A — inline env export (no file changes)

```bash
cd /home/cwsbr/personal/fina/apps/web
NEXT_PUBLIC_API_URL=http://localhost:4000 pnpm exec next dev -p 3100
```

### Option B — `apps/web/.env.local` (persists between runs, gitignored by Next.js default)

```bash
cat > /home/cwsbr/personal/fina/apps/web/.env.local <<'EOF'
NEXT_PUBLIC_API_URL=http://localhost:4000
EOF
cd /home/cwsbr/personal/fina/apps/web
pnpm exec next dev -p 3100
```

**Expected:** `Ready - started server on http://localhost:3100`

> **Why this is needed:** `apps/web/src/env.ts` parses `process.env.NEXT_PUBLIC_API_URL` via Zod. The repo-root `.env` has the value but Next only reads `apps/web/.env*` for the Next project, so without the inline export or `.env.local`, web crashes at startup with:
>
> ```
> ZodError: NEXT_PUBLIC_API_URL Required
> ```

## 3. Owner happy path (Browser window A)

1. Open `http://localhost:3100/sign-in`. Sign up `owner@test.com` with an 8+ character password.
2. Redirect to `/home`. Verify the card shows: **Workspace name** (e.g. `owner's workspace`), **Role: owner**, **Tier: PRO**, and a green **"Pro trial active — ends …"** line.
3. Navigate to `/settings/workspace` via the header link.
   - **Members** table shows yourself (1 row, role=owner).
   - "Invite a member" form: enter `guest@test.com`, role=editor, click **Invite**.
   - Confirm a green "Invite sent to guest@test.com" message appears.
   - **Pending invites** list now shows `guest@test.com (editor)`.
4. **Switch to Terminal 1** (API). Find the line that begins:
   ```
   [dev email] to=guest@test.com subject="owner@test.com invited you to owner's workspace"
   …
   Open this link to accept:
   http://localhost:3100/invites/<TOKEN>
   ```
   Copy that full `http://localhost:3100/invites/<TOKEN>` URL.

## 4. Invitee accept (Browser window B — incognito)

1. In an incognito/private window, paste the invite URL from step 3.
2. **Signed-out behavior:** page shows "Sign in or create an account to view this invite." Click **Sign in / Sign up**.
3. URL is now `/sign-in?from=/invites/<TOKEN>`. Sign up `guest@test.com`.
4. **Critical check:** after sign-up, the browser should redirect to **the invite page**, NOT `/home`. (This is the Next-14 Suspense + sign-in `?from` honor — both Critical fixes from codex review.)
5. The invite preview card appears: **From: owner@test.com**, **Workspace: owner's workspace**, **You'd join as: editor**.
6. Click **Accept invite**. Redirect to `/home`. The header shows **Workspace: owner's workspace (editor)**.

## 5. Member management (back in window A — owner)

1. Refresh `/settings/workspace`. Members table now has 2 rows; Pending invites is empty.
2. **Role change (non-owner):** in `guest@test.com`'s row, change the role select from `editor` to `viewer`. The change applies immediately.
3. **Owner transfer:** change the same select to `owner (transfer)`.
   - **Browser must show a `window.confirm` prompt** (`"Transfer ownership? You will become an editor."`).
   - Click **OK**. Refresh.
4. Post-transfer state in window A: you are now `editor`, guest is `owner`. Your role select disappears (you're no longer owner).
5. **Self-leave:** click **Leave** on your own row. Confirm prompt fires. Workspace is removed from your list — `/workspaces` now returns only your personal one.

## 6. Edge cases (worthwhile checks)

| Scenario | How to trigger | Expected |
|---|---|---|
| Self-invite | As owner, invite your own email | 409 `already_member`, error chip on form |
| Duplicate pending invite | Invite the same email twice | First succeeds, second returns 409 `duplicate_invite` |
| Wrong-email session on accept | Sign in as user X, open invite for user Y | "This invite is for Y. You're signed in as X." + **Sign out** button |
| Expired invite | Force expiry, then visit invite page | Card says "This invite is expired." |
| Last-owner leave | In your personal workspace, click Leave | 409 `last_owner` |
| Header switcher | User belonging to ≥ 2 workspaces visits `/home` | Top-right shows a `<select>` dropdown; switching reloads the page with new active workspace |

### Forcing expiry

```bash
docker exec -it fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE invites SET \"expiresAt\" = NOW() - INTERVAL '1 day' WHERE \"invitedEmail\" = 'guest@test.com';"
```

## 7. Cleanup

```bash
# Ctrl+C both dev servers.

# Wipe smoke-test data (preserves schema):
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "TRUNCATE TABLE invites, memberships, workspaces, verifications, sessions, accounts, users RESTART IDENTITY CASCADE;"

# Optional: stop the dev container (data persists in the docker volume):
# docker stop fina-postgres-dev
```

---

## Troubleshooting

**`ZodError: NEXT_PUBLIC_API_URL Required`** — Next isn't reading the repo-root `.env`. Use Option A or B in step 2.

**API says `WEB_APP_URL` Required at startup** — repo `.env` doesn't have `WEB_APP_URL`. Always launch API with `WEB_APP_URL=http://localhost:3100` inline (step 1).

**API says `DATABASE_URL` invalid** or connection refused — your repo `.env` says port 5432; make sure you launch API with `DATABASE_URL=postgresql://fina:fina@localhost:5433/fina` inline.

**CORS error in browser console (`Access-Control-Allow-Origin`)** — confirm the additive change in `apps/api/src/server.ts` line ~28 includes `http://localhost:3100`. If it doesn't, you're on a stale build; restart the API dev server.

**Better Auth "untrusted origin" 401 on sign-up** — confirm `apps/api/src/auth.ts` line ~26 `trustedOrigins` includes `http://localhost:3100`. Same fix: restart the API. If you're accessing from a non-localhost origin (LAN/Tailscale IP), add it via `DEV_ORIGINS=http://YOUR_IP:3100`.

**`Access to fetch at … blocked by CORS policy: No 'Access-Control-Allow-Origin' header`** — your browser is loading the web app from an origin not in the API's CORS allowlist (e.g. `http://100.65.93.102:3100` instead of `http://localhost:3100`). Restart the API with `DEV_ORIGINS=http://YOUR_ORIGIN` (see "Accessing the web app from another device" in step 1).

**Sign-in works but `/home` shows `Could not reach API: unauthenticated`** — sign-in succeeded (session cookie was set on the API host) but the cookie isn't being sent on subsequent fetches. Almost always a **cross-site** SameSite=Lax issue: web and API are on different hosts (e.g. web on `100.65.93.102:3100`, API on `localhost:4000`). Fix: make web and API share the same host. See "Accessing the web app from another device" in step 1 — set `BETTER_AUTH_URL` and `NEXT_PUBLIC_API_URL` to the same host as the web app, restart both servers, clear cookies, retry.

**Invite POST returns 502 `email_send_failed` with `Resend send failed: API key is invalid`** — the repo `.env` has the placeholder `RESEND_API_KEY=re_...`, which is truthy, so the API tries a real Resend call and gets 401. The codex Significant fix #2 then correctly compensates (revokes the invite and returns 502). For smoke testing you want the dev console fallback (`[dev email]` log). The `pnpm smoke:api*` scripts force `RESEND_API_KEY=` (empty) to disable Resend; if you're starting the API by hand, prefix the same way: `RESEND_API_KEY= DATABASE_URL=… pnpm nx run api:dev`.

**Invite link points to localhost:3000 instead of 3100** — `WEB_APP_URL` was wrong when API booted. Stop API, re-launch with `WEB_APP_URL=http://localhost:3100`.

**`docker exec: no such container`** — the Postgres container isn't running. See "Pre-flight" above.

**Prisma Studio (`db:studio`) errors with `Environment variable not found: DATABASE_URL`** — Prisma reads `.env` from the schema's directory (`apps/api/`), not the repo root. Either inline the URL: `DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api db:studio`, or create `apps/api/.env` with `DATABASE_URL=postgresql://fina:fina@localhost:5433/fina` (gitignored).

### DATABASE_URL cheat sheet (this machine — port 5433)

| Command | Use this `DATABASE_URL` |
|---|---|
| `db:studio` (browse dev data) | `postgresql://fina:fina@localhost:5433/fina` |
| `db:migrate` / `db:deploy` (apply schema changes) | `postgresql://fina:fina@localhost:5433/fina` |
| `nx run api:test` (vitest) | `postgresql://fina:fina@localhost:5433/fina_test` |
| `nx run api:dev` (API for smoke test) | `postgresql://fina:fina@localhost:5433/fina` |

The repo `.env` and `apps/api/.env.test` both hardcode port 5432 (matches `docker-compose.yml`). On this machine port 5432 is taken by another Postgres, so we run on 5433 via the dev container — every command above must override `DATABASE_URL` inline (or via `apps/api/.env` for the dev DB).

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

Disconnect, however, must STILL work for the same trial-expired owner — that's the deliberate exception (a free-tier user must always be able to revoke Plaid access). Click **Disconnect** on a connected bank → confirms 204 + the row disappears.
