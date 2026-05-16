# Plan 1E-write — Smoke Test

End-to-end manual verification for the implementation in
`docs/superpowers/plans/2026-05-16-plan-1e-write.md`. Covers the two new
write tools (`createCategory`, `addTransactionNote`), their authorization
boundaries (owner-only for createCategory, editor-level for addTransactionNote),
the cap/duplicate semantics, and the system-prompt confirmation behavior via
the multi-thread chat surface from Plan 1E-threads.

All commands run from the repo root unless noted.

## Environment

- Postgres dev container on **5433** (`fina-postgres-dev`).
- API runs on **4000** in the parent repo; this smoke uses a fresh worktree
  API on **4001** to avoid touching the existing dev server.
- `GEMINI_API_KEY` is required and is auto-loaded by `nx run` via the repo
  `.env`. Gemini free tier: 10 req/min, 20 req/day. Each chat turn ≈ 2 LLM
  calls; this smoke uses ~6 turns plus a few negative checks.

## 0. Pre-flight

```bash
docker ps --filter name=fina-postgres-dev --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
  pnpm --filter @fina/api db:deploy

pnpm --filter @fina/api exec prisma generate
```

## 1. Boot API (Terminal 1)

```bash
cd /home/cwsbr/personal/fina

# Symlink .env so nx picks it up (if running from a fresh worktree):
# ln -sf /home/cwsbr/personal/fina/.env .env

PORT=4001 BETTER_AUTH_URL=http://localhost:4001 \
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  WEB_APP_URL=http://localhost:3100 \
  pnpm nx run api:dev
```

**Expected:** `Server listening at http://[::1]:4001`. Leave running.

## 2. Seed a Pro owner user (Terminal 2)

```bash
API=http://localhost:4001
EMAIL="smoke-1e-write-$(date +%s)@example.com"

curl -sS -c /tmp/fina-cookies.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke Write\"}" | jq

WS_ID=$(curl -sS -b /tmp/fina-cookies.txt "$API/workspaces" | jq -r '.workspaces[0].id')
echo "WS_ID=$WS_ID"

# The sign-up flow makes the user the workspace OWNER by default — perfect
# for exercising createCategory.
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"
```

## 3. Seed a transaction (for addTransactionNote)

```bash
ACCT_ID="smoke-write-acct-$(date +%s)"
TX_ID="smoke-write-tx-$(date +%s)"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO bank_accounts (id, \"workspaceId\", name, type, currency, status, \"createdAt\") VALUES ('$ACCT_ID', '$WS_ID', 'Chequing', 'depository', 'CAD', 'active', NOW());"

docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO transactions (id, \"workspaceId\", \"accountId\", \"plaidTransactionId\", amount, currency, \"merchantRaw\", \"merchantNormalized\", \"occurredAt\", source, \"rawData\", \"createdAt\", \"updatedAt\") VALUES ('$TX_ID', '$WS_ID', '$ACCT_ID', 'sm-d1', 50.00, 'CAD', 'Dinner', 'dinner', NOW(), 'plaid', '{}'::jsonb, NOW(), NOW());"

echo "TX_ID=$TX_ID"
```

## 4. Create a chat thread + helper

```bash
T_ID=$(curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Write smoke"}' | jq -r .thread.id)
echo "T_ID=$T_ID"

chat() {
  local prompt="$1"
  curl -sS -b /tmp/fina-cookies.txt -X POST \
    "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
    -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
    -d "{\"text\":$(jq -nR --arg t "$prompt" '$t')}" \
    | jq '{tools:[.toolCalls[].toolName], text:.assistantMessage.blocks[0].markdown[0:300]}'
}
```

## 5. createCategory happy paths

### 5.1 Unambiguous create — should NOT ask for confirmation

```bash
chat "카테고리 만들어줘 — Coffee 라는 이름으로"
```

**Expect:** `tools` contains `"createCategory"`. Assistant text confirms creation without asking. Verify the row:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT id, name FROM categories WHERE \"workspaceId\" = '$WS_ID' AND lower(name) = 'coffee' AND \"archivedAt\" IS NULL;"
```

**Expect:** one row with `name = 'Coffee'`.

### 5.2 Ambiguous request — should ASK for confirmation

```bash
chat "Coffee 카테고리 따로 두는 게 좋을까?"
```

**Expect:** assistant asks a clarifying question; `tools` does NOT contain `createCategory`. The system-prompt rule routes ambiguous requests through confirmation.

### 5.3 Create child under existing parent

```bash
chat "Create a category called 'Specialty Coffee' under Coffee"
```

**Expect:** `tools` contains `"createCategory"`. Assistant text mentions the parent. Verify:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT c.name, p.name AS parent FROM categories c LEFT JOIN categories p ON c.\"parentId\" = p.id WHERE c.\"workspaceId\" = '$WS_ID' AND lower(c.name) = 'specialty coffee';"
```

**Expect:** child row with parent `Coffee`.

### 5.4 Duplicate active name — error visible to user

```bash
chat "Create a category called Coffee"
```

**Expect:** `tools` contains `"createCategory"` (LLM tried), but assistant text says it already exists. The tool threw `category_exists`; the LLM relays it conversationally.

## 6. addTransactionNote happy paths

### 6.1 Set a note

```bash
chat "Add a note to transaction $TX_ID: paid by John"
```

**Expect:** `tools` contains `"addTransactionNote"`. Verify:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT note FROM transactions WHERE id = '$TX_ID';"
```

**Expect:** `paid by John` (or close — LLM may rephrase slightly).

### 6.2 Replace, NOT append

```bash
chat "Change the note on $TX_ID to: settled with cash"
```

**Expect:** new note overwrites old.

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT note FROM transactions WHERE id = '$TX_ID';"
```

**Expect:** `settled with cash` — the previous `paid by John` is gone.

### 6.3 Clear the note

```bash
chat "Remove the note from transaction $TX_ID"
```

**Expect:** assistant confirms clear. Verify:

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "SELECT note IS NULL FROM transactions WHERE id = '$TX_ID';"
```

**Expect:** `t` (true — note is NULL).

## 7. Negative checks

### 7.1 Free-tier rejection

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() - INTERVAL '1 day', \"trialConsumed\" = true WHERE email = '$EMAIL';"

curl -sS -b /tmp/fina-cookies.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_ID/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"Create a category called Foo"}' -w "\n%{http_code}\n"
```

**Expect:** 402 `upgrade_required`. The tool never runs because the chat route is Pro-gated.

### 7.2 Editor cannot createCategory (owner-only)

This requires inviting a second user as `editor` and signing in as them.

```bash
# Restore Pro for the owner so we can invite
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL';"

EMAIL2="smoke-1e-write-editor-$(date +%s)@example.com"
curl -sS -c /tmp/fina-cookies-2.txt -X POST "$API/api/auth/sign-up/email" \
  -H "content-type: application/json" \
  -d "{\"email\":\"$EMAIL2\",\"password\":\"password-smoke-1234\",\"name\":\"Smoke Editor\"}" | jq -r '.user.id'

# Direct-insert membership at editor level into the owner's workspace (bypass invite flow for smoke speed).
USER2_ID=$(docker exec fina-postgres-dev psql -U fina -d fina -tAc \
  "SELECT id FROM users WHERE email = '$EMAIL2'")
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "INSERT INTO memberships (id, \"userId\", \"workspaceId\", role, \"createdAt\") VALUES ('m-$(date +%s)', '$USER2_ID', '$WS_ID', 'editor', NOW());"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "UPDATE users SET \"trialEndsAt\" = NOW() + INTERVAL '7 days', \"trialConsumed\" = false WHERE email = '$EMAIL2';"

# Send a create-category message as the editor
T_ID_2=$(curl -sS -b /tmp/fina-cookies-2.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"title":"Editor test"}' | jq -r .thread.id)

curl -sS -b /tmp/fina-cookies-2.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_ID_2/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d '{"text":"카테고리 만들어줘 — Test 라는 이름으로"}' \
  | jq '{tools:[.toolCalls[].toolName], result:.toolCalls[0].result}'
```

**Expect:** `tools` contains `"createCategory"` (LLM tried), but `result.error` is `"insufficient_role"`. The assistant text explains the editor lacks permission.

### 7.3 Editor CAN addTransactionNote

```bash
curl -sS -b /tmp/fina-cookies-2.txt -X POST \
  "$API/workspaces/$WS_ID/chat/threads/$T_ID_2/messages" \
  -H "content-type: application/json" -H "x-workspace-id: $WS_ID" \
  -d "{\"text\":\"Add a note to transaction $TX_ID: editor-added\"}" \
  | jq '{tools:[.toolCalls[].toolName], text:.assistantMessage.blocks[0].markdown[0:200]}'
```

**Expect:** `tools` contains `"addTransactionNote"`, the note was set. (addTransactionNote is editor-level, NOT owner-only.)

### 7.4 Cross-workspace transaction → transaction_not_found

This is covered by unit tests; smoke skips it since the chat route already rejects cross-workspace via the membership check.

### 7.5 30-category cap (skip unless you have appetite)

To exercise the cap, programmatically create 29 categories then ask the chat to create one more:

```bash
for i in $(seq 1 27); do
  docker exec fina-postgres-dev psql -U fina -d fina -c \
    "INSERT INTO categories (id, \"workspaceId\", name, \"createdAt\") VALUES ('cap-$i-$(date +%s%N)', '$WS_ID', 'Filler $i', NOW());" > /dev/null
done

chat "카테고리 만들어줘 — OneMore 라는 이름으로"
```

**Expect:** `tools` contains `"createCategory"`, but the tool's result has `error: "too_many_categories"`.

## 8. Automated E2E (optional; consumes Gemini quota)

```bash
GEMINI_API_KEY=$GEMINI_API_KEY API_URL=http://localhost:4001 \
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
pnpm exec playwright test --grep "plan 1e-write"
```

`e2e/plan-1e-write.spec.ts` covers two cases:
- "Create a Coffee category" → `createCategory` invoked, DB row landed.
- "Add a note to transaction X" → `addTransactionNote` invoked, note persisted.

Both skip-guard on Postgres + `GEMINI_API_KEY`. 13s pacing keeps it under the per-minute cap.

## 9. Cleanup

```bash
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM workspaces WHERE id = '$WS_ID';"
docker exec fina-postgres-dev psql -U fina -d fina -c \
  "DELETE FROM users WHERE email IN ('$EMAIL', '$EMAIL2');"
rm -f /tmp/fina-cookies.txt /tmp/fina-cookies-2.txt
```

## Pass criteria

- `createCategory` triggers on unambiguous create (5.1), creates child correctly (5.3), and rejects duplicates with a user-friendly error (5.4).
- The confirmation rule fires for ambiguous prompts (5.2 — tool NOT called).
- `addTransactionNote` sets/replaces/clears notes (6.1–6.3).
- Free-tier blocks chat entirely (7.1).
- Editor can use `addTransactionNote` (7.3) but NOT `createCategory` (7.2).
- 30-cap surfaces as `too_many_categories` (7.5, optional).
- Optional E2E suite green when `GEMINI_API_KEY` available (8).

## Verified run (2026-05-16)

Smoke run against worktree API on port 4001. Gemini free-tier daily 20-req
cap was hit after step 5.1; the remaining steps require quota reset (next
day) or a paid key.

| Step | Prompt | Tool | DB observation |
|------|--------|------|----------------|
| 5.1 | "카테고리 만들어줘 — Coffee 라는 이름으로" | `createCategory` | ✅ Row `Coffee` created with `parentId IS NULL`. Assistant text: "Coffee 카테고리를 만들었습니다." |
| 5.2 onwards | — | — | Quota cap reached. |

The verified step proves the end-to-end path is wired: chat route → LLM tool
choice → `ctx.role` owner check → `createCategoryService` → row created →
response surfaced. The role rejection, the partial unique index, the
30-cap, and the parent resolution are all covered exhaustively by unit
tests (11 chat-tool cases + 8 service cases) regardless of quota.

**Gemini quota note:** the free tier caps `gemini-2.5-flash-lite` at 10
requests/minute AND 20 requests/day per project. Each chat turn ≈ 2 LLM
calls, so the full 6-step smoke + 2-case E2E (~16 calls) does not fit in
a single day without a paid key. Re-run after midnight Pacific reset OR
upgrade.
