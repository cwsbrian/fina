# Smoke Test — Plan 1C-edit-delete-transaction

**Goal:** validate `PATCH /workspaces/:id/transactions/:txId` and
`DELETE /workspaces/:id/transactions/:txId` end-to-end against a running
local API.

**Pre-req:** `pnpm --filter @fina/api dev` running. Have a workspace
membership cookie for an `editor+` user. Substitute `$WS`, `$COOKIE`,
`$TX` below.

## Setup — create a manual tx

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/transactions/manual" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"merchantRaw":"Costco","amount":42.50,"occurredAt":"2026-05-19","note":"baseline"}'
```

Capture `transaction.id` → `$TX`.

## 1. PATCH partial — amount only

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"amount":99.99}'
```

Expected: 200, `transaction.amount === "99.99"`, other fields unchanged.

## 2. PATCH full — all 5 fields

Create a category first if you don't have one:

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/categories" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"name":"Groceries"}'
```

Capture `category.id` → `$CAT`.

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"amount\":12.34,\"merchantRaw\":\"Walmart\",\"occurredAt\":\"2026-05-18\",\"categoryId\":\"$CAT\",\"note\":\"weekly haul\"}"
```

Expected: 200, all fields updated, `merchantNormalized === "walmart"`.

## 3. PATCH clear categoryId

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"categoryId":null}'
```

Expected: 200, `transaction.categoryId === null`. Also verify in DB that `categorizationSource` is `null`.

## 4. PATCH unknown key (.strict() reject)

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"merchant":"typo"}'
```

Expected: 400, `error === "invalid_body"`.

## 5. PATCH on Plaid tx (manual seed via DB or use one from a sandbox Plaid item)

```bash
# Substitute $PLAID_TX with the id of a known plaid-sourced tx in $WS.
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"amount":1}'
```

Expected: 400, `error === "not_editable"`.

## 6. DELETE manual tx

```bash
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```

Expected: 200, `{ "removed": true }`.

## 7. GET list (default includeRemoved=false) — tx should NOT appear

```bash
curl -sS "http://localhost:3001/workspaces/$WS/transactions" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" | jq '.transactions | map(.id) | contains(["'"$TX"'"])'
```

Expected: `false`.

## 8. GET list with includeRemoved=true — tx should appear with removedAt non-null

```bash
curl -sS "http://localhost:3001/workspaces/$WS/transactions?includeRemoved=true" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" | jq '.transactions[] | select(.id=="'"$TX"'") | .removedAt'
```

Expected: non-null ISO timestamp string.

## 9. DELETE idempotent on second call

```bash
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```

Expected: 200, `{ "removed": false, "alreadyRemoved": true }`.

## 10. DELETE pending Plaid tx (if you have one)

```bash
# Substitute $PENDING_PLAID_TX with a known pending Plaid tx in $WS.
curl -sS -X DELETE "http://localhost:3001/workspaces/$WS/transactions/$PENDING_PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS"
```

Expected: 400, `error === "cannot_delete_pending"`. Verify `removedAt` is still null in DB.

## Result

Record a PASS/FAIL for each of the 10 steps. All PASS = ship.
