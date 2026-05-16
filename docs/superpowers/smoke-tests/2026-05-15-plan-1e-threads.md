# Plan 1E-threads — Smoke Test

End-to-end manual verification for the implementation in
`docs/superpowers/plans/2026-05-15-plan-1e-threads.md`. Covers schema
migration, the six new chat routes (create/list/detail/patch/delete/messages),
multi-thread isolation, archive flow, and Pro/role gating.

All commands run from the repo root unless noted.

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`).
- API runs on **4000** in the parent repo; this worktree's API is brought up on
  **4001** to coexist with the existing dev server.
- This plan requires `GEMINI_API_KEY` (in repo `.env`, auto-loaded by `nx run`).
- Gemini free-tier limits (gemini-2.5-flash-lite as of 2026-05): **10 req/min**
  and **20 req/day**. Each chat turn issues 2 LLM calls. The smoke uses ~6
  chat turns (~12 calls) so you can run smoke OR E2E in one day; both together
  will hit the daily cap unless you have a paid key.

## 0. Pre-flight

```bash
# Verify Postgres
docker ps --filter name=fina-postgres-dev --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Apply migrations to dev + test DB
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api db:deploy

# Regenerate Prisma client in this worktree
pnpm --filter @fina/api exec prisma generate
```

## 1. Boot API (Terminal 1)

```bash
cd /home/cwsbr/personal/fina/.claude/worktrees/plan-1e-threads

# Symlink the repo-root .env so nx auto-loads GEMINI_API_KEY etc.
ln -sf /home/cwsbr/personal/fina/.env .env

# Worktree runs on 4001 to avoid conflict with the parent server on 4000.
PORT=4001 BETTER_AUTH_URL=http://localhost:4001 \
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  WEB_APP_URL=http://localhost:3100 \
  pnpm nx run api:dev
```

**Expected:** `Server listening at http://[::1]:4001`. Leave running.

## 2. Seed a Pro user (Terminal 2)

```bash
API=http://localhost:4001
EMAIL="smoke-1e-threads-$(date +%s)@example.com"
PASSWORD="password-smoke-1234"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"name\":\"Smoke Threads\"}" | jq

WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
echo "WS_ID=$WS_ID"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

## 3. Create two threads

```bash
# POST /chat/threads — Thread A
T_A=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Codeword chat"}' | jq -r .thread.id)
echo "T_A=$T_A"

# Thread B (no title — exercises nullable title)
T_B=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{}' | jq -r .thread.id)
echo "T_B=$T_B"
```

**Expect:** both return 201 with `{ thread: { id, title, lastMessageAt: null, archivedAt: null, createdAt } }`.

## 4. Multi-thread isolation via chat

Helper:

```bash
chat() {
  local tid="$1"; local prompt="$2"
  curl -sS -b /tmp/fina-cookies.txt -X POST \
    "$API/workspaces/$WS_ID/chat/threads/$tid/messages" \
    -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
    -d "{\"text\":$(jq -nR --arg t "$prompt" '$t')}" \
    | jq '{thread:.threadId, text:.assistantMessage.blocks[0].markdown[0:200], toolCalls:[.toolCalls[].toolName]}'
}
```

### 4.1 Send a codeword to Thread A

```bash
chat "$T_A" "Remember the codeword PINEAPPLE. I'll ask later."
```

**Expect:** assistant acknowledges PINEAPPLE.

### 4.2 Ask Thread B for the codeword (should be blind)

```bash
chat "$T_B" "What's the codeword I just told you?"
```

**Expect:** assistant does NOT mention PINEAPPLE — its history is empty/scoped.

### 4.3 Confirm Thread A still remembers

```bash
chat "$T_A" "What's the codeword?"
```

**Expect:** assistant recalls PINEAPPLE.

## 5. List threads

```bash
curl -sS -b /tmp/fina-cookies.txt "$API/workspaces/$WS_ID/chat/threads" \
  | jq '.threads | map({id, title, lastMessageAt, messageCount, firstMessagePreview})'
```

**Expect:**
- 2 threads, sorted by `lastMessageAt` descending (most recently chatted first).
- Thread A: title "Codeword chat", non-null `lastMessageAt`, `messageCount > 0`, `firstMessagePreview` starts with "Remember the codeword".
- Thread B: title null, non-null `lastMessageAt` (after 4.2), `messageCount > 0`.

## 6. Fetch detail

```bash
curl -sS -b /tmp/fina-cookies.txt \
  "$API/workspaces/$WS_ID/chat/threads/$T_A" | jq '{thread:.thread.title, msgCount:(.messages|length)}'
```

**Expect:** thread.title "Codeword chat", at least 4 messages (2 user + 2 assistant from 4.1 and 4.3).

## 7. Rename a thread (PATCH)

```bash
curl -sS -b /tmp/fina-cookies.txt -X PATCH \
  "$API/workspaces/$WS_ID/chat/threads/$T_A" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Codeword chat (renamed)"}' | jq .thread.title
```

**Expect:** `"Codeword chat (renamed)"`. Then PATCH again with `"title":null`
and confirm the title clears.

## 8. Archive a thread (DELETE)

```bash
curl -sS -b /tmp/fina-cookies.txt -X DELETE \
  "$API/workspaces/$WS_ID/chat/threads/$T_B" -w "\n%{http_code}\n"
```

**Expect:** 204.

```bash
# Second DELETE (idempotency)
curl -sS -b /tmp/fina-cookies.txt -X DELETE \
  "$API/workspaces/$WS_ID/chat/threads/$T_B" -w "\n%{http_code}\n"
```

**Expect:** 204 again.

```bash
# Message-send on archived thread → 404
curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_B/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"hi"}' -w "\n%{http_code}\n"
```

**Expect:** 404 with `{"error":"thread_not_found"}`.

```bash
# GET on archived thread still works (read access preserved)
curl -sS -b /tmp/fina-cookies.txt \
  "$API/workspaces/$WS_ID/chat/threads/$T_B" | jq '.thread.archivedAt'
```

**Expect:** archivedAt set, not null.

```bash
# List excludes archived by default
curl -sS -b /tmp/fina-cookies.txt "$API/workspaces/$WS_ID/chat/threads" \
  | jq '.threads | map(.id)'
```

**Expect:** only Thread A.

```bash
# List with include_archived=true returns both
curl -sS -b /tmp/fina-cookies.txt \
  "$API/workspaces/$WS_ID/chat/threads?include_archived=true" \
  | jq '.threads | map(.id)'
```

**Expect:** both threads.

## 9. Negative checks

### 9.1 Free-tier message-send rejection

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() - INTERVAL '1 day', \"trialConsumed\" = true WHERE email = '$EMAIL';"

curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_A/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"test"}' -w "\n%{http_code}\n"
```

**Expect:** 402 `upgrade_required`.

### 9.2 Free-tier GET still works

```bash
curl -sS -b /tmp/fina-cookies.txt \
  "$API/workspaces/$WS_ID/chat/threads/$T_A" -w "\n%{http_code}\n"
```

**Expect:** 200. Downgraded users can still read history.

### 9.3 Cross-workspace isolation

Sign up a second user in a separate workspace, then try to access Thread A:

```bash
EMAIL2="smoke-1e-threads-other-$(date +%s)@example.com"
curl -sS -c /tmp/fina-cookies-2.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"$PASSWORD\",\"name\":\"Other\"}" > /dev/null
WS_ID_2=$(curl -sS -b /tmp/fina-cookies-2.txt "$API/workspaces" | jq -r '.workspaces[0].id')

curl -sS -b /tmp/fina-cookies-2.txt \
  "$API/workspaces/$WS_ID_2/chat/threads/$T_A" -w "\n%{http_code}\n"
```

**Expect:** 404 `thread_not_found` (NOT 200 with leaked data, NOT 403 — same code as missing).

## 10. Automated E2E (optional; consumes Gemini quota)

```bash
cd /home/cwsbr/personal/fina/.claude/worktrees/plan-1e-threads
GEMINI_API_KEY=$GEMINI_API_KEY API_URL=http://localhost:4001 \
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
pnpm exec playwright test --grep "plan 1e-threads"
```

The spec at `e2e/plan-1e-threads.spec.ts` covers:
- two-threads-in-one-workspace isolation (PINEAPPLE codeword)
- archive blocks message-send + read still works

Both tests skip-guard on Postgres + `GEMINI_API_KEY`. `--workers=1` + 13s
beforeEach pacing keeps it under the free-tier 10 req/min cap.

## 11. Cleanup

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM workspaces WHERE id IN ('$WS_ID', '$WS_ID_2');"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM users WHERE email IN ('$EMAIL', '$EMAIL2');"
rm -f /tmp/fina-cookies.txt /tmp/fina-cookies-2.txt
```

## Pass criteria

- All 6 routes work as specified (3, 5, 6, 7, 8).
- Multi-thread isolation holds — Thread B does not see Thread A's codeword (4).
- Archive blocks message-send (404), keeps read (200) (8).
- DELETE is idempotent (8).
- Free-tier rejection on mutating routes (9.1).
- Free-tier GET still works (9.2).
- Cross-workspace isolation returns 404 (9.3).
- Optional E2E (10) green when key available.
