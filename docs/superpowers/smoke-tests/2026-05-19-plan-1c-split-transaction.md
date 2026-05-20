# Smoke Test — Plan 1C-split-transaction

**Goal:** validate the unified allocations model end-to-end against a
running local API.

**Pre-req:** `pnpm --filter @fina/api dev` running. Have a workspace
membership cookie for an `editor+` user. Substitute `$WS`, `$COOKIE`,
`$TX`, `$CAT` below.

## Setup — create a manual tx (no category)

```bash
curl -sS -X POST "http://localhost:3001/workspaces/$WS/transactions/manual" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d '{"merchantRaw":"Costco","amount":200,"occurredAt":"2026-05-19"}'
```

Expected: 201, response includes `allocations: [{categoryId: null, amount: "200", source: null}]`, no top-level `categoryId`.
Capture `transaction.id` → `$TX`.

## 1. Create three categories

```bash
for n in Groceries Electronics Household; do
  curl -sS -X POST "http://localhost:3001/workspaces/$WS/categories" \
    -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
    -d "{\"name\":\"$n\"}"
done
```

Capture each category id → `$G`, `$E`, `$H`.

## 2. PATCH with categoryId shortcut

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$G\"}"
```

Expected: 200, `transaction.allocations` has 1 entry with `categoryId === $G`, `amount === "200"`, `source === "manual"`.

## 3. PATCH split — 3 allocations summing to 200

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"allocations\":[{\"categoryId\":\"$G\",\"amount\":120},{\"categoryId\":\"$E\",\"amount\":50},{\"categoryId\":\"$H\",\"amount\":30}]}"
```

Expected: 200, `transaction.allocations` has 3 entries summing to 200.

## 4. PATCH back to single via shortcut

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$G\"}"
```

Expected: 200, allocations replaced with 1 entry covering full 200.

## 5. PATCH sum_mismatch

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"allocations\":[{\"categoryId\":\"$G\",\"amount\":100}]}"
```

Expected: 400, `error === "sum_mismatch"`.

## 6. PATCH conflicting_body

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$G\",\"allocations\":[{\"categoryId\":\"$G\",\"amount\":200}]}"
```

Expected: 400, `error === "conflicting_body"`.

## 7. PATCH amount and allocations atomically

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"amount\":250,\"allocations\":[{\"categoryId\":\"$G\",\"amount\":150},{\"categoryId\":\"$E\",\"amount\":100}]}"
```

Expected: 200, `transaction.amount === "250"`, allocations sum to 250.

## 8. PATCH on Plaid pending tx (if available)

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$PENDING_PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"categoryId\":\"$G\"}"
```

Expected: 400, `error === "cannot_split_pending"`.

## 9. PATCH on Plaid posted tx with allocations

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$POSTED_PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"allocations\":[{\"categoryId\":\"$G\",\"amount\":<plaid_tx_amount>}]}"
```

Expected: 200 (per-field rule allows allocations on posted Plaid).

## 10. PATCH on Plaid posted tx with amount (per-field rule rejects)

```bash
curl -sS -X PATCH "http://localhost:3001/workspaces/$WS/transactions/$POSTED_PLAID_TX" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" -H "content-type: application/json" \
  -d "{\"amount\":99.99}"
```

Expected: 400, `error === "not_editable"`.

## 11. GET tx — verify response shape

```bash
curl -sS "http://localhost:3001/workspaces/$WS/transactions?from=2026-05-01&to=2026-05-31" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" | jq '.transactions[] | select(.id=="'"$TX"'") | {allocations,needsReclassification}'
```

Expected: each tx has `allocations` array and `needsReclassification` boolean; NO top-level `categoryId`.

## 12. GET filter by category

```bash
curl -sS "http://localhost:3001/workspaces/$WS/transactions?categoryId=$G" \
  -H "Cookie: $COOKIE" -H "X-Workspace-Id: $WS" | jq '.transactions | length'
```

Expected: count includes split tx attributed to $G AND single-category tx where $G is the only allocation.

## Result

Record a PASS/FAIL for each of the 12 steps. All PASS = ship.
