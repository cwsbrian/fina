# Plan 1C-recurring-persist — Smoke Test

End-to-end manual verification for the implementation in
`docs/superpowers/plans/2026-05-17-plan-1c-recurring-persist.md`. Covers:

1. HTTP `POST /workspaces/:id/recurring` — happy path, invalid_amount,
   upgrade_required, workspace_mismatch.
2. HTTP `GET /workspaces/:id/recurring` — viewer access.
3. HTTP `DELETE /workspaces/:id/recurring/:id` — happy path + 404.
4. `addRecurring` chat tool — unambiguous prompt → row in DB.
5. `listRecurring` chat tool — returns the row.
6. `removeRecurring` chat tool — deletes by name.

All commands run from the repo root unless noted.

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`).
- API runs on **4001** (worktree); dev server on **4000** is left untouched.
- `GEMINI_API_KEY` required for the chat steps (auto-loaded from `.env`).
- Gemini free tier: 10 req/min, 20 req/day. Each chat turn ≈ 2-3 LLM
  calls. Budget ~3 chat turns for this smoke.

## 0. Pre-flight

```bash
docker ps --filter name=fina-postgres-dev --format "table {{.Names}}\t{{.Status}}"
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:deploy
pnpm --filter @fina/api exec prisma generate
```

## 1. Boot API (Terminal 1)

```bash
cd /home/cwsbr/personal/fina
PORT=4001 BETTER_AUTH_URL=http://localhost:4001 \
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  WEB_APP_URL=http://localhost:3100 \
  pnpm nx run api:dev
```

**Expect:** `Server listening at http://[::1]:4001`.

## 2. Seed Pro user + category (Terminal 2)

```bash
API=http://localhost:4001
EMAIL="smoke-recurring-$(date +%s)@example.com"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke Recurring\"}" | jq

WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
echo "WS_ID=$WS_ID"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"

CAT_ID="smoke-rec-cat-$(date +%s)"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO categories (id, \"workspaceId\", name, \"createdAt\") VALUES ('$CAT_ID', '$WS_ID', 'Streaming', NOW());"

echo "CAT_ID=$CAT_ID"
```

## 3. HTTP route smoke (steps 3.1-3.7)

### 3.1 POST 201 happy

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/recurring" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"name\":\"Netflix\",\"amount\":19.99,\"cadence\":\"monthly\",\"nextOccurrenceDate\":\"2026-07-01\",\"categoryId\":\"$CAT_ID\"}" \
  -w "\nHTTP %{http_code}\n"
```

**Expect:** `201` + `{ recurring: { name: "Netflix", amount: "19.99", cadence: "monthly", nextOccurrenceDate: "2026-07-01" } }`.

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT name, amount, cadence, \"nextOccurrenceDate\", \"nameNormalized\" FROM recurring_expenses WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:** one row, `nameNormalized = netflix`.

### 3.2 POST upsert — same name (different case) updates amount

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/recurring" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"name\":\"netflix\",\"amount\":22.99,\"cadence\":\"monthly\",\"nextOccurrenceDate\":\"2026-08-01\"}" \
  -w "\nHTTP %{http_code}\n"

docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT count(*) || '/' || max(amount) FROM recurring_expenses WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:** `201` + still `1 row`, `max(amount) = 22.99`.

### 3.3 POST 400 invalid_amount

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/recurring" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"name\":\"X\",\"amount\":0,\"cadence\":\"monthly\",\"nextOccurrenceDate\":\"2026-07-01\"}" \
  -w "\nHTTP %{http_code}\n"
```

**Expect:** `400` + `{"error":"invalid_amount"}`.

### 3.4 POST 402 upgrade_required

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() - INTERVAL '1 day', \"trialConsumed\" = true WHERE email = '$EMAIL';"

curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/recurring" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"name\":\"Y\",\"amount\":9.99,\"cadence\":\"monthly\",\"nextOccurrenceDate\":\"2026-07-01\"}" \
  -w "\nHTTP %{http_code}\n"

# Restore Pro
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

**Expect:** `402` + `{"error":"upgrade_required"}`.

### 3.5 GET 200

```bash
curl -sS -b /tmp/fina-cookies.txt "$API/workspaces/$WS_ID/recurring" \
  -H "x-workspace-id: $WS_ID" -w "\nHTTP %{http_code}\n"
```

**Expect:** `200` + `{ recurring: [{ name: "netflix", amount: "22.99", ... }] }`.

### 3.6 DELETE 204 + 404

```bash
REC_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT id FROM recurring_expenses WHERE \"workspaceId\" = '$WS_ID' LIMIT 1")
echo "REC_ID=$REC_ID"

curl -sS -b /tmp/fina-cookies.txt -X DELETE \
  "$API/workspaces/$WS_ID/recurring/$REC_ID" \
  -H "x-workspace-id: $WS_ID" -w "HTTP %{http_code}\n"

curl -sS -b /tmp/fina-cookies.txt -X DELETE \
  "$API/workspaces/$WS_ID/recurring/does-not-exist" \
  -H "x-workspace-id: $WS_ID" -w "\nHTTP %{http_code}\n"
```

**Expect:** first `204`, second `404 recurring_not_found`.

## 4. Chat tool smoke

```bash
# Re-seed since DELETE cleared it
curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/recurring" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"name\":\"Netflix\",\"amount\":19.99,\"cadence\":\"monthly\",\"nextOccurrenceDate\":\"2026-07-01\"}" > /dev/null

T_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Recurring smoke"}' | jq -r .thread.id)
echo "T_ID=$T_ID"

chat() {
  local prompt="$1"
  curl -sS -b /tmp/fina-cookies.txt -X POST \
    "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
    -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
    -d "{\"text\":$(jq -nR --arg t "$prompt" '$t')}" \
    | jq '{tools:[.toolCalls[].toolName], firstResult:.toolCalls[0].result}'
}
```

### 4.1 addRecurring — unambiguous prompt

```bash
chat "Spotify를 semimonthly(격주) 9달러 정기지출로 추가, 다음은 2026-07-15"
```

**Expect:** `tools` contains `"addRecurring"`. `firstResult.recurring` has `name: "Spotify"`, `cadence: "semimonthly"`, `amount: "9.00"`, `nextOccurrenceDate: "2026-07-15"`.

### 4.2 listRecurring

```bash
chat "내 정기 지출 목록 보여줘"
```

**Expect:** `tools` contains `"listRecurring"`. `firstResult.recurring` has 2 rows (Netflix + Spotify).

### 4.3 removeRecurring

```bash
chat "Spotify 정기지출 삭제해줘"
```

**Expect:** `tools` contains `"removeRecurring"`. `firstResult.removed: true`. DB에서 Spotify 삭제 확인:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT name FROM recurring_expenses WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:** Only Netflix remains.

## 5. Cleanup

```bash
lsof -ti tcp:4001 | xargs -r kill

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM workspaces WHERE id = '$WS_ID';"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM users WHERE email = '$EMAIL';"
```

## Verified run (2026-05-17)

**Steps 3.1-3.6 (HTTP routes) — all 6 PASS:**

```
3.1 POST 201 happy        → 201 + { name: "Netflix", amount: "19.99", cadence: "monthly", nextOccurrenceDate: "2026-07-01" } ✓
3.2 POST upsert           → 201, 1 row, max(amount) = 22.99 (nameNormalized dedup works: "Netflix" → "netflix") ✓
3.3 POST 400 invalid_amt  → 400 { error: "invalid_amount" } ✓
3.4 POST 402 Free tier    → 402 { error: "upgrade_required" } ✓
3.5 GET 200               → 200 { recurring: [{ name: "netflix", amount: "22.99", ... }] } ✓
3.6 DELETE 204 + 404      → 204 + { error: "recurring_not_found" } ✓
```

**Steps 4.1-4.3 (chat tools) — all 3 PASS:**

4.1 `addRecurring` — "Spotify를 semimonthly(격주) 9달러 정기지출로 추가, 다음은 2026-07-15":
```
tool: addRecurring
result: { name: "Spotify", cadence: "semimonthly", amount: "9.00",
          nextOccurrenceDate: "2026-07-15" }
```
DB: Netflix (monthly) + Spotify (semimonthly) — `semimonthly` cadence stored correctly.

4.2 `listRecurring` — "내 정기 지출 목록 보여줘":
```
tool: listRecurring
result: recurring=[Netflix(Jul 1), Spotify(Jul 15)] — ordered by nextOccurrenceDate ASC ✓
```

4.3 `removeRecurring` — "Spotify 정기지출 삭제해줘":
```
tool: removeRecurring
result: { removed: true }
```
DB: Only Netflix remains. Spotify hard-deleted. ✓

## Known limitations

- **Gemini quota.** 3 chat turns × ~3 LLM calls = ~9 calls. Free tier 20/day shared
  across session. If `429 RESOURCE_EXHAUSTED`, defer chat steps to integration
  tests (all semantics covered in `apps/api/tests/chat.tools.add-recurring.test.ts`,
  etc.).
- **semimonthly second-anchor.** Only `nextOccurrenceDate` stored. Future occurrence
  sequence derivation is a Phase 2 forecast follow-up.
- **No active/pause.** Cancel = hard delete. Archived-category entries remain in
  recurring list with `categoryName: null` (by design, preserves the entry).
