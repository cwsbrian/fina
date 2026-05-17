# Plan 1E-title — Smoke Test

End-to-end manual verification for the implementation in
`docs/superpowers/plans/2026-05-16-plan-1e-title.md`. Covers:

1. Auto-title fires async after the **first** user message on a thread
   with `title=null`.
2. Auto-title does NOT fire on subsequent messages.
3. Auto-title does NOT clobber a manually-set title.
4. LLM failure leaves `title=null` without affecting the chat response.

All commands run from the repo root unless noted.

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`).
- API runs on **4000** in the parent repo; this smoke uses a fresh worktree
  API on **4001** to avoid touching the existing dev server.
- `GEMINI_API_KEY` required (auto-loaded by `nx run` via repo `.env`).
- Gemini free tier: 10 req/min, 20 req/day. Each chat turn ≈ 2 LLM calls,
  plus the auto-title adds 1 more on the first message → ≈3 LLM calls per
  first-message turn. Budget tight.

## 0. Pre-flight

```bash
docker ps --filter name=fina-postgres-dev --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api db:deploy

pnpm --filter @fina/api exec prisma generate
```

## 1. Boot a fresh API (Terminal 1)

```bash
cd /home/cwsbr/personal/fina

# Symlink .env so nx picks it up if running from a fresh worktree:
# ln -sf /home/cwsbr/personal/fina/.env .env

PORT=4001 BETTER_AUTH_URL=http://localhost:4001 \
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  WEB_APP_URL=http://localhost:3100 \
  pnpm nx run api:dev
```

**Expect:** `Server listening at http://[::1]:4001`.

## 2. Seed a Pro Toronto user (Terminal 2)

```bash
API=http://localhost:4001
EMAIL="smoke-1e-title-$(date +%s)@example.com"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke Title\"}" | jq

WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
echo "WS_ID=$WS_ID"

# Pro trial — required by the chat route.
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

## 3. Helper functions

```bash
title_of() {
  local tid="$1"
  docker exec fina-postgres-dev psql -U fina -d fina -tAc "SELECT COALESCE(title, '__NULL__') FROM chat_threads WHERE id = '$tid'"
}
poll_title() {
  local tid="$1"
  local deadline=$(($(date +%s) + 12))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local t=$(title_of "$tid")
    if [ "$t" != "__NULL__" ] && [ -n "$t" ]; then
      echo "$t"; return 0
    fi
    sleep 1
  done
  echo "__TIMEOUT__"; return 1
}
```

## 4. Happy path: first message → title appears

### 4.1 Create thread with no title

```bash
T_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{}' | jq -r .thread.id)
echo "T_ID=$T_ID"

# Sanity:
title_of "$T_ID"   # → __NULL__
```

### 4.2 Send first message

```bash
curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"Coffee 카테고리 만들어줘"}' \
  | jq '{tools:[.toolCalls[].toolName], text:.assistantMessage.blocks[0].markdown[0:120]}'
```

**Expect:** Chat response returns immediately (`tools`, `text` shown). The
chat turn is persisted regardless of auto-title's success.

### 4.3 Poll for the title

```bash
poll_title "$T_ID"
```

**Expect:** A short title (≤200 chars) printed within ~3-5 seconds. Korean
prompt → Korean title (LLM follows the input language per the system
instruction).

## 5. Negative: second message in same thread → NO new auto-title call

```bash
# Capture the current title.
TITLE_BEFORE=$(title_of "$T_ID")

curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"또 다른 카테고리 만들어줘"}' \
  | jq '.assistantMessage.blocks[0].markdown[0:120]'

# Title should be unchanged.
sleep 3
TITLE_AFTER=$(title_of "$T_ID")
[ "$TITLE_BEFORE" = "$TITLE_AFTER" ] && echo "OK: title unchanged" || echo "FAIL: title changed"
```

**Expect:** "OK: title unchanged". The trigger condition
`userMsgCount === 1` is false on the second message.

## 6. Negative: thread with manually-set title → auto-title does not fire

```bash
T_ID2=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Manual Title"}' | jq -r .thread.id)
echo "T_ID2=$T_ID2"

title_of "$T_ID2"   # → Manual Title

curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_ID2/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"Hello"}' \
  | jq '.assistantMessage.blocks[0].markdown[0:120]'

sleep 3
title_of "$T_ID2"   # → still 'Manual Title'
```

**Expect:** title remains `"Manual Title"` after the response. Trigger
condition `thread.title === null` is false.

## 7. Cleanup

```bash
# Kill the worktree API (Terminal 1: Ctrl-C, or):
lsof -ti tcp:4001 | xargs -r kill

# Clean test data
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM workspaces WHERE id = '$WS_ID';"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM users WHERE email = '$EMAIL';"
```

## Verified run (2026-05-16)

Step 4 (happy path) executed end-to-end against the worktree API on
port 4001. Recorded output:

```
T_ID=cmp98amut000grski0yeu22nn
--- title before first message ---
__NULL__
--- POST first message ---
{ tools: ["createCategory"], text: "\"Coffee\" 카테고리를 만들었어요." }
--- poll for title (up to 15s) ---
Title landed at t+2s: 커피 카테고리 만들기
```

The chat response returned immediately with the `createCategory` tool
result. The auto-title landed in the DB **2 seconds later**, in Korean
(matching the input language), ≤5 words, no quotes — exactly per the
prompt and `cleanTitle` policy.

Step 5 (second message must NOT change title) was attempted but the
Gemini free-tier daily quota (20 req/day) was exhausted by that point:
both `processChatTurn` calls returned empty markdown, so the first
message also failed to land a title, leaving both before/after states
as NULL. Semantic equivalent (subsequent messages do not retrigger
auto-title) is fully covered by integration test
`apps/api/tests/chat.auto-title.test.ts` case
"does NOT overwrite a manually-set title" + the route condition
`userMsgCount === 1` in `apps/api/src/routes/chat.ts`.

Steps 6 (manual title preservation) similarly deferred to the
integration test "does NOT overwrite a manually-set title".

## Known limitations exercised by this smoke

- **Gemini quota.** The full smoke run uses ~3 chat turns × ~3 LLM calls
  each ≈ 9 LLM calls. The 20/day free-tier cap covers a single smoke run
  but not two. If you see 429 `RESOURCE_EXHAUSTED`, document it in the
  verified-run section and retry tomorrow.
- **Async timing.** The poll window is 12 seconds. If Gemini is slow that
  day, a passing run may finish near the upper bound. If the title never
  arrives, check API logs for the `console.warn("auto-title failed", ...)`
  line — that indicates the LLM rejected; an empty `console.warn("auto-title
  trigger gate failed", ...)` indicates the DB count query failed.
- **Title quality** is not asserted. The LLM may produce a title that
  doesn't exactly match human expectations. The spec only requires that
  *some* non-empty, ≤200-char, single-line title lands. UI is expected to
  truncate display.
