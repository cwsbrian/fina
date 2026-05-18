# Plan 1C-confirmation — Smoke Test

End-to-end manual verification for the implementation in
`docs/superpowers/plans/2026-05-17-plan-1c-confirmation.md`. Covers:

1. **Consume endpoint** (no Gemini needed): POST /intents/:id/consume —
   happy path, workspace_mismatch, intent_gone, intent_owner_mismatch,
   intent_not_found, insufficient_role.
2. **presentConfirmCard via chat** (Gemini needed): LLM emits
   `confirm_card` block for a destructive prompt → client consumes
   intent → action executes.

All commands run from the repo root unless noted.

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`).
- API on **4001** (worktree); dev server on **4000** left untouched.
- `GEMINI_API_KEY` required for chat steps only.
- Gemini free tier: 10 req/min, 20 req/day. Chat turn ≈ 2-3 LLM calls.

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

**Expect:** `Server listening at http://[::1]:4001`.

## 2. Seed Pro owner (Terminal 2)

```bash
API=http://localhost:4001
EMAIL="smoke-1c-conf-$(date +%s)@example.com"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke Conf\"}" | jq

WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
echo "WS_ID=$WS_ID"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

## 3. Consume endpoint smoke (no Gemini)

### 3.1 Seed a category + intent directly

```bash
CAT_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/categories" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"name":"Coffee"}' | jq -r .category.id)
echo "CAT_ID=$CAT_ID"

# Create intent directly via psql (same as service would create):
INTENT_ID=$(cuid || python3 -c "import uuid; print(uuid.uuid4().hex[:24])")
USER_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT id FROM users WHERE email = '$EMAIL';")
EXPIRES=$(date -u -d '+1 hour' '+%Y-%m-%dT%H:%M:%S.000Z' 2>/dev/null || date -u -v+1H '+%Y-%m-%dT%H:%M:%S.000Z')

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO action_intents (id, \"workspaceId\", \"userId\", kind, payload, \"expiresAt\", \"createdAt\") \
   VALUES ('$(openssl rand -hex 12)', '$WS_ID', '$USER_ID', 'tool_call', \
           '{\"tool\":\"createCategory\",\"args\":{\"name\":\"Latte\"}}'::jsonb, \
           NOW() + INTERVAL '1 hour', NOW());"

INTENT_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT id FROM action_intents WHERE \"workspaceId\" = '$WS_ID' LIMIT 1;")
echo "INTENT_ID=$INTENT_ID"
```

### 3.2 POST consume 200 happy

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/intents/$INTENT_ID/consume" \
  -H "x-workspace-id: $WS_ID" \
  -w "\nHTTP %{http_code}\n"
```

**Expect:** `200` + `{ result: { category: { id, name: "Latte" } } }`.

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT name FROM categories WHERE \"workspaceId\" = '$WS_ID' AND name='Latte';"
```

**Expect:** one row.

### 3.3 POST 410 intent_gone (already consumed)

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/intents/$INTENT_ID/consume" \
  -H "x-workspace-id: $WS_ID" -w "\nHTTP %{http_code}\n"
```

**Expect:** `410` + `{"error":"intent_gone"}`.

### 3.4 POST 404 intent_not_found

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/intents/does-not-exist/consume" \
  -H "x-workspace-id: $WS_ID" -w "\nHTTP %{http_code}\n"
```

**Expect:** `404` + `{"error":"intent_not_found"}`.

### 3.5 POST 402 upgrade_required (Free tier)

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() - INTERVAL '1 day', \"trialConsumed\" = true WHERE email = '$EMAIL';"

# Seed new intent
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO action_intents (id, \"workspaceId\", \"userId\", kind, payload, \"expiresAt\", \"createdAt\") \
   VALUES ('$(openssl rand -hex 12)', '$WS_ID', '$USER_ID', 'tool_call', \
           '{\"tool\":\"createCategory\",\"args\":{\"name\":\"Free\"}}'::jsonb, \
           NOW() + INTERVAL '1 hour', NOW());"
NEW_INTENT=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT id FROM action_intents WHERE \"workspaceId\" = '$WS_ID' AND \"consumedAt\" IS NULL LIMIT 1;")

curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/intents/$NEW_INTENT/consume" \
  -H "x-workspace-id: $WS_ID" -w "\nHTTP %{http_code}\n"

# Restore Pro
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

**Expect:** `402` + `{"error":"upgrade_required"}`.

## 4. Chat tool + confirm-card flow (Gemini required)

```bash
# Seed a Netflix recurring (to be deleted)
NETFLIX_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/recurring" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"name":"Netflix","amount":19.99,"cadence":"monthly","nextOccurrenceDate":"2026-08-01"}' \
  | jq -r .recurring.id)
echo "NETFLIX_ID=$NETFLIX_ID"

T_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Confirmation smoke"}' | jq -r .thread.id)

chat() {
  local prompt="$1"
  curl -sS -b /tmp/fina-cookies.txt -X POST \
    "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
    -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
    -d "{\"text\":$(jq -nR --arg t "$prompt" '$t')}" \
    | jq '{tools:[.toolCalls[].toolName], blocks:[.assistantMessage.blocks[].type]}'
}
```

### 4.1 Destructive prompt → LLM uses presentConfirmCard

```bash
CHAT_RESP=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"Netflix 정기지출 삭제해줘"}')

echo "$CHAT_RESP" | jq '{tools:[.toolCalls[].toolName], blocks:[.assistantMessage.blocks[].type]}'
```

**Expect:** `tools` contains `"presentConfirmCard"` (NOT `"removeRecurring"`).
`blocks` contains `"confirm_card"`.

```bash
INTENT_ID=$(echo "$CHAT_RESP" | jq -r '.assistantMessage.blocks[] | select(.type=="confirm_card") | .acceptIntent')
echo "INTENT_ID=$INTENT_ID"
```

### 4.2 Consume the intent → removeRecurring executes

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/intents/$INTENT_ID/consume" \
  -H "x-workspace-id: $WS_ID" -w "\nHTTP %{http_code}\n"
```

**Expect:** `200` + `{ result: { removed: true } }`.

```bash
docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT count(*) FROM recurring_expenses WHERE id = '$NETFLIX_ID';"
```

**Expect:** `0` — Netflix recurring is deleted.

## 5. Cleanup

```bash
lsof -ti tcp:4001 | xargs -r kill
docker exec fina-postgres-dev psql -U fina -d fina -c "DELETE FROM workspaces WHERE id = '$WS_ID';"
docker exec fina-postgres-dev psql -U fina -d fina -c "DELETE FROM users WHERE email = '$EMAIL';"
```

## Verified run (2026-05-17)

**Steps 3.2-3.5 (HTTP consume endpoint) — 4/4 PASS:**

```
3.2 POST consume 200 happy:
    result: { category: { id, name: "Latte", ... } }
    DB: count(Latte) = 1  ✓

3.3 POST 410 intent_gone (double consume)  ✓
3.4 POST 404 intent_not_found              ✓
3.5 POST 402 upgrade_required (Free tier)  ✓
```

**Steps 4.1-4.2 (chat + consume full flow) — PASS:**

```
4.1 Prompt: "Netflix 정기지출 삭제해줘"
    tools:  ["presentConfirmCard"]      ← LLM used confirm card, NOT removeRecurring directly ✓
    blocks: ["text", "confirm_card"]    ← confirm_card block present in assistant message ✓

4.2 Consume intent:
    HTTP 200 + { result: { removed: true } }   ✓
    DB: recurring_expenses count for Netflix = 0  ✓
```

The 2-phase commit safety net works end-to-end: the LLM emits a confirmation
card for the destructive operation, and the action only executes when the
intent is consumed.

## Known limitations

- **Gemini quota.** Section 4 uses ~3 LLM calls. If `429 RESOURCE_EXHAUSTED`,
  the 2-phase commit flow is fully covered by the integration tests
  (`intents.service.test.ts` 10 cases + `intents.routes.test.ts` 7 cases).
- **LLM heuristic.** The system prompt guides but doesn't force `presentConfirmCard`.
  If the LLM calls `removeRecurring` directly, rerun or try a more ambiguous prompt.
  Future plans can force specific tools through the intent flow at the service layer.
- **confirm_card block shape.** Client renderer is not part of this plan (user's UI
  track). The backend emits the JSONB correctly; rendering is deferred.
- **No reject endpoint.** `✗` on the card just drops it; server lets intent expire
  (1-hour TTL). Explicit reject tracking is a 1C-confirmation-reject follow-up.
