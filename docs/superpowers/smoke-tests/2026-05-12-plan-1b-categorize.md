# Plan 1B-categorize Smoke Test

**Date:** 2026-05-12
**Builds on:** Plan 1B-foundation smoke test (`docs/superpowers/smoke-tests/2026-05-08-plan-2-workspace-sharing.md` Plaid Addendum)

---

## Prerequisites

```bash
# 1. All Plan 1B-foundation prerequisites (Plaid creds, ENCRYPTION_KEY)
export PLAID_CLIENT_ID=...
export PLAID_SECRET=...
export PLAID_ENV=sandbox
export ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

# 2. NEW: Gemini API key (free tier at https://aistudio.google.com/app/apikey)
export GEMINI_API_KEY=...

# 3. Start services
pnpm smoke:db:start          # ensure fina-postgres-dev is running
pnpm smoke:api               # Terminal A — API at localhost:4000
pnpm smoke:web               # Terminal B — web at localhost:3100
```

Note: without `GEMINI_API_KEY`, the API refuses to start (now required env var).
Use `GEMINI_API_KEY=placeholder` to start without real Gemini — categories CRUD and manual categorize work fine; auto-categorize after Plaid sync fails gracefully (transactions stay uncategorized, sync itself succeeds).

---

## Part 1: Categories API (no Plaid needed)

```bash
# Sign up + get session
curl -s -c /tmp/smoke-cookies.txt \
  -X POST http://localhost:4000/api/auth/sign-up/email \
  -H "content-type: application/json" \
  -d '{"email":"cat-smoke@test.com","password":"password123","name":"CatSmoke"}' \
  | jq '{id: .user.id}'

# Get workspace id
WS=$(curl -s -b /tmp/smoke-cookies.txt http://localhost:4000/workspaces \
  | jq -r '.workspaces[0].id')
echo "Workspace: $WS"

# 1a. List seeded categories — should show 11 defaults
curl -s -b /tmp/smoke-cookies.txt \
  "http://localhost:4000/workspaces/$WS/categories" \
  -H "x-workspace-id: $WS" \
  | jq '[.categories[].name] | sort'
# Expected: ["Dining","Entertainment","Groceries","Health","Housing","Income","Other","Shopping","Subscriptions","Transit","Utilities"]

# 1b. Create new category
curl -s -b /tmp/smoke-cookies.txt \
  -X POST "http://localhost:4000/workspaces/$WS/categories" \
  -H "x-workspace-id: $WS" \
  -H "content-type: application/json" \
  -d '{"name":"Hobbies"}' \
  | jq '{name: .category.name}'
# Expected: {"name": "Hobbies"}

# 1c. Case-insensitive duplicate → 422
curl -s -o /dev/null -w "%{http_code}\n" -b /tmp/smoke-cookies.txt \
  -X POST "http://localhost:4000/workspaces/$WS/categories" \
  -H "x-workspace-id: $WS" \
  -H "content-type: application/json" \
  -d '{"name":"hobbies"}'
# Expected: 422
```

---

## Part 2: Manual categorize + merchant_mapping (no Plaid or Gemini needed)

After connecting Plaid (Part 3), or manually create test transactions.

```bash
# List uncategorized transactions
curl -s -b /tmp/smoke-cookies.txt \
  "http://localhost:4000/workspaces/$WS/transactions?uncategorizedOnly=true&limit=5" \
  -H "x-workspace-id: $WS" \
  | jq '[.transactions[] | {id, merchantRaw}]'

# Manually categorize one
TX_ID=<paste a transaction id from above>
curl -s -b /tmp/smoke-cookies.txt \
  -X POST "http://localhost:4000/workspaces/$WS/transactions/$TX_ID/categorize" \
  -H "x-workspace-id: $WS" \
  -H "content-type: application/json" \
  -d '{"categoryName": "Dining"}' \
  | jq '{
    source: .transaction.categorizationSource,
    merchant: .transaction.merchantNormalized,
    backfilled: .backfilledCount
  }'
# Expected: source="manual", backfilled=N (siblings with same merchant)

# Verify merchant_mapping was created
docker exec fina-postgres-dev psql -U fina -d fina \
  -c "SELECT \"merchantNormalized\", source FROM merchant_mappings WHERE \"workspaceId\" = '$WS';"
```

---

## Part 3: Full flow — Plaid connect + auto-categorize

### 3a. Connect Plaid

1. Browser → `http://localhost:3100/sign-in` → sign up
2. Click **Banks** → Connect → Tartan-Dominion Bank → `user_good`/`pass_good`
3. Skip phone → select accounts → Continue → Finish without saving

### 3b. Verify auto-categorize

Wait 5-10 seconds after connect, then check:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c "
SELECT
  t.\"merchantRaw\",
  t.\"merchantNormalized\",
  c.name AS category,
  t.\"categorizationSource\"
FROM transactions t
LEFT JOIN categories c ON c.id = t.\"categoryId\"
WHERE t.\"workspaceId\" = '$WS'
ORDER BY t.\"occurredAt\" DESC
LIMIT 20;"
```

Expected (with real Gemini): all rows have `category` + `categorizationSource = 'ai'` or `'mapping'`.
Expected (with placeholder Gemini): `category = NULL`, `categorizationSource = NULL` (sync succeeded, categorize failed silently).

### 3c. Uncategorized filter

```bash
curl -s -b /tmp/smoke-cookies.txt \
  "http://localhost:4000/workspaces/$WS/transactions?uncategorizedOnly=true" \
  -H "x-workspace-id: $WS" \
  | jq '.transactions | length'
# Expected: 0 (all categorized) or N (if placeholder Gemini)
```

---

## Automated E2E

```bash
# Group 1 — no Gemini needed: categories CRUD + manual categorize + uncategorizedOnly
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  API_URL=http://localhost:4000 \
  WEB_URL=http://localhost:3100 \
  pnpm e2e -- --grep "categorize"

# Group 2 — requires real PLAID_* AND real GEMINI_API_KEY:
# (already in e2e/plan-1b-categorize.spec.ts, skips without credentials)
```

---

## Exit Criteria

- [ ] 11 default categories seeded on signup
- [ ] POST /categories creates + case-insensitive duplicate blocked (422)
- [ ] POST /transactions/:id/categorize → tx `source=manual` + merchant_mapping row + siblings back-filled
- [ ] GET /transactions?uncategorizedOnly=true filters correctly
- [ ] (real Gemini) Plaid connect → all tx auto-categorized within 10s
- [ ] (real Gemini) `categorizationSource` is `ai` for LLM-assigned, `mapping` for repeat merchants
