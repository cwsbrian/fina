# Plan 1B-foundation Smoke Test — Plaid Sandbox

**Date:** 2026-05-11  
**Prerequisites:** API + web running, Plaid sandbox credentials exported.

---

## Pre-flight

### 1. Plaid credentials (one-time)

Sign up at https://dashboard.plaid.com → Sandbox. Copy `client_id` and `secret`.

```bash
# Generate encryption key (do this once, save the output somewhere safe)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Export before running any smoke script
export PLAID_CLIENT_ID=<your-sandbox-client-id>
export PLAID_SECRET=<your-sandbox-secret>
export PLAID_ENV=sandbox
export ENCRYPTION_KEY=<your-base64-32-byte-key>
```

### 2. Start services

Terminal A — API:
```bash
pnpm smoke:api        # localhost:4000
# LAN / Tailscale:
# pnpm smoke:api:lan  # uses BETTER_AUTH_URL + DEV_ORIGINS
```

Terminal B — Web:
```bash
pnpm smoke:web        # localhost:3100
# pnpm smoke:web:lan
```

Terminal C — Database Studio (optional):
```bash
pnpm smoke:db:studio  # http://localhost:5555
```

### 3. Automated API checks (no browser, no Plaid credentials needed)

Run this first — it validates all the new endpoints before touching the browser:

```bash
node docs/superpowers/smoke-tests/scripts/plan-1b-api-check.mjs
```

Or manually with curl (see §API Curl Checks below).

---

## Browser Smoke Test (Manual)

### A. Sign up + verify Pro trial

1. Open `http://localhost:3100/sign-in`
2. Sign up with a new email (e.g. `test+plaid@example.com`)
3. Should redirect to `/home`
4. Verify Pro trial active — in Prisma Studio, `users` table: `trialEndsAt` ≈ 30 days from now, `trialConsumed = false`

### B. Banks page loads

1. Click **Banks** in the header nav → `/settings/banks`
2. Should show: "Connect your bank account…" + **Connect a bank** button
3. No errors in browser console

### C. Connect a bank (requires Plaid sandbox credentials)

1. Click **Connect a bank**
2. Plaid Link modal opens
3. Search for / pick **"Tartan Bank"** (sandbox institution)
4. Credentials:
   - Username: `user_good`
   - Password: `pass_good`
   - MFA (if prompted): `1234`
5. Select one or more accounts → **Continue**
6. Modal closes, page shows connected bank card with:
   - Institution name
   - Account count
   - "last sync" timestamp

### D. Verify data in DB

Open Prisma Studio (`http://localhost:5555`):

| Table | Expected |
|---|---|
| `plaid_items` | 1 row, `status = active`, `accessTokenCiphertext` opaque bytes |
| `bank_accounts` | rows with `mask`, `balanceCurrent`, `archivedAt = null` |
| `transactions` | rows with `merchantRaw`, `amount`, `occurredAt`, `plaidItemId` set |

### E. Manual Refresh

Click **Refresh** on the bank card:
- Toast: `+0 added, 0 modified, 0 removed` (sandbox doesn't generate new txs)
- Repeat-clicking fast may show "Another refresh is already running" → FOR UPDATE NOWAIT working

### F. Disconnect

1. Click **Disconnect** → confirm the dialog
2. Card disappears from the list
3. In Prisma Studio:
   - `plaid_items` row → **gone**
   - `bank_accounts` row → **still exists**, `archivedAt` set, `plaidItemId = null`
   - `transactions` rows → **still exist**, `plaidItemId = null`

### G. Free-tier gate

Force trial expiry:
```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\"=NOW()-INTERVAL '1 day', \"trialConsumed\"=true WHERE email='test+plaid@example.com';"
```

Reload `/settings/banks`:
- **Connect a bank** button → replaced with "Plaid is a Pro feature — upgrade to connect a bank"

API check:
```bash
# Get wsId from Prisma Studio → workspaces table
curl -i -X POST http://localhost:4000/workspaces/<wsId>/plaid/link-token \
  -H "x-workspace-id: <wsId>" \
  --cookie "<session cookie from browser DevTools>"
# Expected: HTTP 402  {"error":"upgrade_required"}
```

### H. Free-tier CAN still disconnect (deliberate exception)

With trial expired, if a bank is still connected, the **Disconnect** button must still work:
```bash
curl -i -X DELETE http://localhost:4000/workspaces/<wsId>/plaid-items/<plaidItemId> \
  -H "x-workspace-id: <wsId>" \
  --cookie "<session cookie>"
# Expected: HTTP 204 (no error, item deleted)
```

---

## API Curl Checks

No browser needed. Requires the API running and a signed-up user.

```bash
API=http://localhost:4000

# 1. Health
curl -s $API/health | jq .

# 2. Sign up (get a session cookie)
curl -s -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d '{"email":"smoke@example.com","password":"password123","name":"Smoke"}' | jq .user.id

# 3. /me — verify Pro trial
curl -s -b /tmp/fina-cookies.txt $API/me | jq '{tier,trial}'
# Expected: {"tier":"pro","trial":{"active":true,"endsAt":"..."}}

# 4. Get workspace id
WS_ID=$(curl -s -b /tmp/fina-cookies.txt $API/workspaces | jq -r '.workspaces[0].id')
echo "ws: $WS_ID"

# 5. link-token — should succeed (Pro trial active)
curl -s -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/plaid/link-token" \
  -H "x-workspace-id: $WS_ID" | jq .
# Expected: {"linkToken":"link-sandbox-...","expiration":"..."}

# 6. plaid-items list (empty)
curl -s -b /tmp/fina-cookies.txt "$API/workspaces/$WS_ID/plaid-items" \
  -H "x-workspace-id: $WS_ID" | jq .plaidItems
# Expected: []

# 7. accounts (empty)
curl -s -b /tmp/fina-cookies.txt "$API/workspaces/$WS_ID/accounts" \
  -H "x-workspace-id: $WS_ID" | jq .accounts
# Expected: []

# 8. transactions (empty)
curl -s -b /tmp/fina-cookies.txt "$API/workspaces/$WS_ID/transactions" \
  -H "x-workspace-id: $WS_ID" | jq '.transactions | length'
# Expected: 0

# 9. workspace_mismatch guard
FAKE_WS="fake_workspace_id_$(date +%s)"
curl -s -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$FAKE_WS/plaid/link-token" \
  -H "x-workspace-id: $WS_ID" | jq .error
# Expected: "workspace_mismatch"

# 10. Force free tier and verify 402
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\"=NOW()-INTERVAL '1 day', \"trialConsumed\"=true WHERE email='smoke@example.com';"
curl -s -o /dev/null -w "%{http_code}" -b /tmp/fina-cookies.txt \
  -X POST "$API/workspaces/$WS_ID/plaid/link-token" \
  -H "x-workspace-id: $WS_ID"
# Expected: 402

# 11. Transactions date filter
curl -s -b /tmp/fina-cookies.txt \
  "$API/workspaces/$WS_ID/transactions?from=2026-05-01&to=2026-05-31" \
  -H "x-workspace-id: $WS_ID" | jq .nextCursor
# Expected: null (no txs yet)

# 12. Invalid date → 400
curl -s -o /dev/null -w "%{http_code}" -b /tmp/fina-cookies.txt \
  "$API/workspaces/$WS_ID/transactions?from=not-a-date" \
  -H "x-workspace-id: $WS_ID"
# Expected: 400
```

---

## Playwright Automated Check

Automates login + navigation + Pro-gate UI verification (no Plaid credentials needed for this part):

```bash
node docs/superpowers/smoke-tests/scripts/plan-1b-playwright.mjs
```

The script validates:
- Sign-up flow works
- `/settings/banks` loads without error
- "Connect a bank" button visible for Pro user
- "Plaid is a Pro feature" upgrade message visible for free-tier user
- Header nav has "Banks" link

---

## Concurrency (manual)

Open two browser tabs, both on the same workspace's `/settings/banks`. Click **Refresh** in both simultaneously. One should show "Another refresh is already running." (the row-level lock working).

---

## Exit Criteria

- [ ] API: `pnpm nx run api:test` → 146 passing
- [ ] Typecheck: `pnpm nx run-many -t typecheck` → 4/4 green
- [ ] Lint: `pnpm nx run-many -t lint` → 0 errors
- [ ] Browser: Connect → see bank + accounts + transactions in DB
- [ ] Disconnect → accounts/transactions survive (archivedAt set, plaidItemId null)
- [ ] Free-tier: 402 on link-token, upgrade message in UI
- [ ] Free-tier disconnect: 204 (deliberate exception — not gated)
- [ ] Encryption: `accessTokenCiphertext` in DB is opaque bytes, not raw string
