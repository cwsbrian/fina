# Plan 1C-add-transaction — Smoke Test

End-to-end manual verification for `docs/superpowers/plans/2026-05-17-plan-1c-add-transaction.md`.
HTTP-only — no Gemini required.

Covers:
1. **Free-tier 201 happy path** — auto-creates Cash account, `source = "manual"`
2. **Fractional-cent rejection** — `amount: 0.004` → 400 `invalid_amount`
3. **Cash account reuse** — second POST reuses the same account
4. **Workspace.currency inheritance** — Transaction.currency = workspace.currency

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`)
- API on **4001** (worktree)

## 0. Pre-flight

```bash
docker ps --filter name=fina-postgres-dev --format "table {{.Names}}\t{{.Status}}"
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:deploy
pnpm --filter @fina/api exec prisma generate
```

## 1. Boot API (Terminal 1)

```bash
PORT=4001 BETTER_AUTH_URL=http://localhost:4001 \
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  WEB_APP_URL=http://localhost:3100 \
  pnpm nx run api:dev
```

## 2. Free-tier user signup (Terminal 2)

```bash
API=http://localhost:4001
EMAIL="smoke-1c-addtx-$(date +%s)@example.com"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke AddTx\"}" > /dev/null
WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
USER_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc "SELECT id FROM users WHERE email = '$EMAIL';")
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() - INTERVAL '1 day', \"trialConsumed\" = true WHERE email = '$EMAIL';" > /dev/null
echo "WS_ID=$WS_ID  USER_ID=$USER_ID (Free tier)"
```

## 3. POST happy path 201 + Cash auto-create

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/transactions/manual" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"merchantRaw":"Starbucks Yonge","amount":6.75,"occurredAt":"2026-05-17"}' \
  -w "\nHTTP %{http_code}\n" | jq

echo "--- bank_accounts after POST ---"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT name, type, \"plaidItemId\" IS NULL AS no_plaid_item, \"plaidAccountId\" IS NULL AS no_plaid_acct
   FROM bank_accounts WHERE \"workspaceId\" = '$WS_ID';"

echo "--- transactions after POST ---"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT \"merchantRaw\", \"merchantNormalized\", amount, currency, source
   FROM transactions WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:**
- HTTP 201, `transaction.source = "manual"`, `merchantNormalized = "starbucks yonge"`
- One `bank_accounts` row: `name = "Cash"`, `type = "depository"`, both plaid fields NULL
- One `transactions` row: `amount = 6.75`, `currency = "CAD"`, `source = "manual"`

## 4. POST fractional-cent → 400 invalid_amount

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/transactions/manual" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"merchantRaw":"X","amount":0.004}' \
  -w "\nHTTP %{http_code}\n"
```

**Expect:** `400` + `{"error":"invalid_amount"}`

## 5. POST second → reuses Cash account

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/transactions/manual" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"merchantRaw":"Tim Hortons","amount":4.50,"occurredAt":"2026-05-17"}' \
  -w "\nHTTP %{http_code}\n" | jq '.transaction.accountId'

echo "--- bank_accounts count after 2nd POST ---"
docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT count(*)::text FROM bank_accounts WHERE \"workspaceId\" = '$WS_ID' AND \"plaidItemId\" IS NULL AND \"plaidAccountId\" IS NULL AND \"archivedAt\" IS NULL;"

echo "--- transactions count ---"
docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT count(*)::text FROM transactions WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:**
- HTTP 201, `accountId` matches the Cash account from step 3
- Cash account count = 1 (not 2)
- transactions count = 2

## 6. Currency inheritance check

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE workspaces SET currency = 'USD' WHERE id = '$WS_ID';"

curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/transactions/manual" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"merchantRaw":"USD Tx","amount":10.00,"occurredAt":"2026-05-17"}' \
  | jq '.transaction.currency'

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT \"merchantRaw\", currency FROM transactions WHERE \"workspaceId\" = '$WS_ID' ORDER BY \"createdAt\" DESC LIMIT 3;"
```

**Expect:**
- Response: `"USD"`
- USD row in transactions; first two rows from earlier steps still `CAD` (set at insert time)

## 7. Cleanup

```bash
lsof -ti tcp:4001 | xargs -r kill
docker exec fina-postgres-dev psql -U fina -d fina -c "DELETE FROM workspaces WHERE id = '$WS_ID';"
docker exec fina-postgres-dev psql -U fina -d fina -c "DELETE FROM users WHERE email = '$EMAIL';"
```

## Verified run (2026-05-17)

All 4 smoke steps PASS against worktree API on port 4001 with Free-tier user.

**Step 3 — Free-tier 201 + Cash auto-create:**
```
HTTP 201
{ source: "manual", merchantNormalized: "starbucks yonge",
  currency: "CAD", accountId: "cmp..." }
bank_accounts: name=Cash, type=depository, no_plaid_item=t, no_plaid_acct=t  ✓
```

**Step 4 — fractional cent rejection:**
```
amount: 0.004  →  HTTP 400 + {"error":"invalid_amount"}  ✓
```

**Step 5 — Cash account reuse:**
```
ACCT1 (1st POST) = ACCT2 (2nd POST)  ✓
cash_accts = 1, tx_count = 2  ✓
```

**Step 6 — Workspace.currency inheritance:**
```
After UPDATE workspaces SET currency='USD':
new transaction.currency = "USD"  ✓
```

## Known limitations

- HTTP route only — no chat tool (intentional, deferred to follow-up)
- HTTP route not audited (audit only fires on chat / intent-consume paths;
  HTTP audit deferred to `1C-audit-http`)
- "Cash" account name hardcoded; rename UX deferred
- No edit/delete endpoints — separate plans
