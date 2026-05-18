# Plan 1C-audit — Smoke Test

End-to-end manual verification for the implementation in
`docs/superpowers/plans/2026-05-17-plan-1c-audit.md`. Covers:

1. **Direct HTTP route write** (no Gemini): `POST /workspaces/:id/recurring` →
   seeded audit row checked.
2. **Intent consume path** (no Gemini): `POST /intents/:id/consume` →
   audit row with actorType=user + intentId.
3. **Direct chat write** (Gemini needed): createCategory via chat →
   audit row with actorType=agent.

All commands run from the repo root unless noted.

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`).
- API on **4001** (worktree); dev server on **4000** left untouched.
- `GEMINI_API_KEY` required for step 3 only.

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

## 2. Seed Pro user (Terminal 2)

```bash
API=http://localhost:4001
EMAIL="smoke-1c-audit-$(date +%s)@example.com"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke Audit\"}" | jq

WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
USER_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT id FROM users WHERE email = '$EMAIL';")
echo "WS_ID=$WS_ID  USER_ID=$USER_ID"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

## 3. Step 3.1 — HTTP write creates audit row

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST "$API/workspaces/$WS_ID/recurring" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"name":"Audit Test","amount":9.99,"cadence":"monthly","nextOccurrenceDate":"2026-08-01"}' \
  -w "\nHTTP %{http_code}\n"

sleep 1  # brief wait for fire-and-forget

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT \"actorType\", action, \"targetType\", \"actorUserId\" = '$USER_ID' AS own_user
   FROM audit_events WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:**
- HTTP 201
- One audit row with `actorType = agent`, `action = addRecurring`, `targetType = recurring_expense`, `own_user = t`

Wait — this is an HTTP route write (not through LLM), but it still goes through `addRecurringService` which is called from the route handler, NOT from `processChatTurn`. So the audit hook in turn.ts won't fire here.

Actually audit hooks are in:
- `apps/api/src/chat/turn.ts` (chat-driven direct writes)
- `apps/api/src/intents/service.ts` (intent consume)

The HTTP route for `addRecurring` is NOT hooked into audit logging. Only chat tool and intent consume paths are audited.

Corrected smoke: to see an audit row from HTTP, we need to go through the intent consume path directly.

## 3. Step 3.1 — Intent consume path creates audit row with actorType=user

```bash
# Seed a createCategory intent directly
INTENT_ID="smoke-audit-int-$(date +%s)"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO action_intents (id, \"workspaceId\", \"userId\", kind, payload, \"expiresAt\", \"createdAt\") \
   VALUES ('$INTENT_ID', '$WS_ID', '$USER_ID', 'tool_call', \
           '{\"tool\":\"createCategory\",\"args\":{\"name\":\"AuditCat\"}}'::jsonb, \
           NOW() + INTERVAL '1 hour', NOW());"

curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/intents/$INTENT_ID/consume" \
  -H "x-workspace-id: $WS_ID" -w "\nHTTP %{http_code}\n"

sleep 1  # fire-and-forget

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT \"actorType\", action, \"targetType\", \"intentId\", \"actorUserId\" = '$USER_ID' AS own_user
   FROM audit_events WHERE \"workspaceId\" = '$WS_ID';"
```

**Expect:**
- HTTP 200
- Audit row: `actorType = user`, `action = createCategory`, `targetType = category`, `intentId = $INTENT_ID`, `own_user = t`

## 4. Step 4 — Chat write creates audit row with actorType=agent (Gemini required)

```bash
T_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Audit smoke"}' | jq -r .thread.id)

curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"카테고리 만들어줘 — AuditSmoke 라는 이름으로"}' \
  | jq '{tools:[.toolCalls[].toolName]}'

sleep 2  # fire-and-forget with network delay

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT \"actorType\", action, \"targetType\", \"actorUserId\" = '$USER_ID' AS own_user
   FROM audit_events WHERE \"workspaceId\" = '$WS_ID' AND \"actorType\" = 'agent';"
```

**Expect:**
- `tools` contains `"createCategory"` (direct, no confirm card since prompt is unambiguous)
- Audit row: `actorType = agent`, `action = createCategory`, `targetType = category`, `own_user = t`

## 5. Cleanup

```bash
lsof -ti tcp:4001 | xargs -r kill
docker exec fina-postgres-dev psql -U fina -d fina -c "DELETE FROM workspaces WHERE id = '$WS_ID';"
docker exec fina-postgres-dev psql -U fina -d fina -c "DELETE FROM users WHERE email = '$EMAIL';"
```

## Verified run (2026-05-18)

Both smoke paths verified against worktree API on port 4001.

**Step 3.1 — Intent consume (actorType=user):**
```
HTTP 200 + { result: { category: { id, name: "AuditCat" } } }
audit_events:
  actorType=user, action=createCategory, targetType=category,
  intent_matches=t, own_user=t  ✓
```

**Step 4 — Chat direct write (actorType=agent):**
```
tools: ["createCategory"]  (unambiguous prompt → no confirm card)
audit_events (2 rows after both steps):
  1. user  | createCategory | category  | no_intent=f (from intent consume)
  2. agent | createCategory | category  | no_intent=t (from chat direct)  ✓
```

Both actorType values (`user` for intent consume, `agent` for chat) verified.
intentId presence/absence matches expectation.

## Known limitations

- **HTTP routes are not directly audited.** Only chat tool dispatch (turn.ts) and
  intent consume (intents/service.ts) produce audit rows. HTTP routes that call
  services directly (addRecurring via `/recurring`, etc.) are not hooked. This is
  by design for v1 — a future `1C-audit-http` plan can add hooks at the route level.
- **Fire-and-forget timing.** The `void logAuditEvent()` call completes asynchronously.
  The smoke uses `sleep 1-2` delays; if the DB is under heavy load, increase to `sleep 5`.
- **Gemini quota.** Step 4 uses ~2-3 LLM calls. If `429 RESOURCE_EXHAUSTED`,
  the chat-path audit behavior is proven by the integration test
  `apps/api/tests/audit.service.test.ts` case "processChatTurn write tool fires
  an audit row with actorType=agent".
