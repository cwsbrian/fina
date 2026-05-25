# Plan 1K-cleanup-chat-index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Register `chat_threads_userId_archivedAt_lastMessageAt_idx` in `schema.prisma` via `@@index` so `prisma migrate dev` stops auto-generating DROP statements; restore the index on dev/test DBs where it's currently missing.

**Architecture:** Single-task plan. Add `@@index([userId, archivedAt, lastMessageAt(sort: Desc, nulls: Last)])` to `ChatThread` model. Create one idempotent CREATE INDEX IF NOT EXISTS migration. Apply to both DBs. Verify via 5 gates (validation, auto-name check, deploy, drift check, smoke tests).

**Tech Stack:** Prisma 5.22 (supports `nulls: "Last"` in @@index since 5.5+), Postgres on port 5433.

---

## Context — read before any step

- **Spec:** `docs/superpowers/specs/2026-05-24-plan-1k-cleanup-chat-index-design.md` (HEAD `eca594e`). Authoritative.
- **Root cause:** `prisma migrate dev` autogenerates `DROP INDEX "chat_threads_userId_archivedAt_lastMessageAt_idx"` whenever schema doesn't declare it. Past Plan 2B `_plan_2b_daily_brief` + recent `_billing_pending_tier` both triggered this drop. Current dev/test DB state: index missing → 2 chat.migration.smoke tests fail.
- **No worktree** — single task, single commit, no parallel agent dispatching needed. Run on a worktree at user's discretion; the steps work in-place on main too.
- **Existing files:**
  - `apps/api/prisma/schema.prisma` ChatThread model at ~line 560-576 (verify by grep).
  - `apps/api/tests/chat.migration.smoke.test.ts` 5 tests, 2 currently failing.
  - Past restoration migrations stay untouched (needed for fresh-clone lexical replay).

## File map

| File | Action |
|---|---|
| `apps/api/prisma/schema.prisma` | Modify — add `@@index([userId, archivedAt, lastMessageAt(sort: Desc, nulls: Last)])` to `ChatThread`; remove the stale comment "Index lives in the migration SQL..." |
| `apps/api/prisma/migrations/<timestamp>_chat_listing_index_in_schema/migration.sql` | Create — `CREATE INDEX IF NOT EXISTS` |

---

## Task 1: Schema-side @@index + idempotent migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_chat_listing_index_in_schema/migration.sql`

- [ ] **Step 1.1: Confirm baseline — tests currently fail**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.migration.smoke.test.ts 2>&1 | tail -8
```

Expected: 2 fail / 3 pass. Failing tests:
- "index chat_threads_userId_archivedAt_lastMessageAt_idx exists" (gets count=0)
- "EXPLAIN of the user-listing query uses the new index"

- [ ] **Step 1.2: Modify `schema.prisma` ChatThread model**

In `apps/api/prisma/schema.prisma`, locate the `ChatThread` model (around line 560). The current shape (verify with `grep -n "model ChatThread" apps/api/prisma/schema.prisma`):

```prisma
model ChatThread {
  id            String    @id @default(cuid())
  userId        String
  workspaceId   String?
  title         String?
  lastMessageAt DateTime?
  archivedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  user      User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace?    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  messages  ChatMessage[]

  // Index lives in the migration SQL because @@index can't express NULLS LAST.
  @@map("chat_threads")
}
```

Replace the existing `// Index lives in the migration SQL...` comment line and the `@@map` line with:

```prisma
  // Supports the chat-thread listing query at apps/api/src/chat/threads.ts:
  //   findMany WHERE userId = ? ORDER BY archivedAt ASC, lastMessageAt DESC NULLS LAST.
  // Prisma 5.5+ supports the `nulls` keyword in @@index — that's why this
  // can finally live in schema instead of raw migration SQL.
  @@index([userId, archivedAt, lastMessageAt(sort: Desc, nulls: Last)])
  @@map("chat_threads")
```

- [ ] **Step 1.3: Validate + format schema**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec prisma validate && pnpm --filter @fina/api exec prisma format
```

Expected: validate produces no output (no error). format may rewrite whitespace; check `git diff apps/api/prisma/schema.prisma` to confirm only the intended change.

- [ ] **Step 1.4: Auto-name check — verify Prisma's generated index name**

Use the tight grep pattern from spec §5 step 1.5 (column names are double-quoted in emitted SQL → avoids false positives on unrelated indexes):

```bash
cd /home/cwsbr/personal/fina/apps/api && pnpm exec prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script | grep '"chat_threads"' | grep '"lastMessageAt"'
```

Expected output line contains: `chat_threads_userId_archivedAt_lastMessageAt_idx`

If the emitted name differs, return to Step 1.2 and add `, map: "chat_threads_userId_archivedAt_lastMessageAt_idx"` inside the `@@index(...)` parentheses, then re-run Step 1.3 and Step 1.4 until name matches.

- [ ] **Step 1.5: Manually create the migration file**

Generate UTC timestamp + create the migration directory with the exact SQL (do NOT use `prisma migrate dev --create-only` here — we want to control the SQL because the `IF NOT EXISTS` form is critical for the DBs that already have the index vs the ones that don't).

```bash
cd /home/cwsbr/personal/fina && TS=$(date -u +%Y%m%d%H%M%S) && mkdir -p apps/api/prisma/migrations/${TS}_chat_listing_index_in_schema && cat > apps/api/prisma/migrations/${TS}_chat_listing_index_in_schema/migration.sql << 'EOF'
-- Plan 1K-cleanup-chat-index: schema-side @@index addition is idempotent
-- on DBs that already have the index, restorative on DBs that don't (e.g.,
-- those affected by the billing-pending-tier auto-DROP). IF NOT EXISTS
-- keeps it safe in both cases.
CREATE INDEX IF NOT EXISTS "chat_threads_userId_archivedAt_lastMessageAt_idx"
  ON "chat_threads" ("userId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
EOF
echo "Created: apps/api/prisma/migrations/${TS}_chat_listing_index_in_schema/migration.sql"
```

- [ ] **Step 1.6: Apply migration to both DBs**

```bash
cd /home/cwsbr/personal/fina/apps/api && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm exec prisma migrate deploy
cd /home/cwsbr/personal/fina/apps/api && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm exec prisma migrate deploy
```

Expected (each): "1 migration applied" (or "no pending migrations" if already applied).

- [ ] **Step 1.7: Regenerate Prisma client**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec prisma generate
```

Expected: "Generated Prisma Client".

- [ ] **Step 1.8: Schema-DB sync verification**

```bash
cd /home/cwsbr/personal/fina/apps/api && pnpm exec prisma migrate diff --from-url=postgresql://fina:fina@localhost:5433/fina --to-schema-datamodel prisma/schema.prisma --script
```

Expected: `-- This is an empty migration.`

- [ ] **Step 1.9: Recurrence regression check — the main payoff**

```bash
cd /home/cwsbr/personal/fina/apps/api && pnpm exec prisma migrate dev --name regression_check --create-only
```

Expected: "No schema changes found." (Prisma 5.22 wording) → no migration directory generated.

**Any non-empty `migration.sql` is a blocker** (spec §5 step 4):
- `DROP INDEX "chat_threads_userId_archivedAt_lastMessageAt_idx"` → schema/DB drift, the fix didn't take. Investigate.
- `CREATE INDEX` with a DIFFERENT name → Step 1.4's `map:` fallback was missed. Return to 1.4.
- Anything else → unexpected, debug.

If a `regression_check` migration directory was accidentally generated (despite "No schema changes found."), delete it: `rm -rf apps/api/prisma/migrations/*_regression_check`.

- [ ] **Step 1.10: Test gate — chat.migration.smoke.test.ts**

```bash
cd /home/cwsbr/personal/fina && DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.migration.smoke.test.ts 2>&1 | tail -8
```

Expected: 5 pass / 0 fail.

- [ ] **Step 1.11: Typecheck**

```bash
cd /home/cwsbr/personal/fina && pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" | wc -l
```

Expected: same count as pre-fix baseline (10 errors, all pre-existing — unchanged).

- [ ] **Step 1.12: Commit**

```bash
cd /home/cwsbr/personal/fina && git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/ && git commit -m "fix(api): chat listing index in schema — kill recurring auto-DROP

Plan 1K-cleanup-chat-index. chat_threads_userId_archivedAt_lastMessage
At_idx kept getting auto-DROP'd by every 'prisma migrate dev' because
it was raw SQL only (not in @@index). Last regression: _billing_
pending_tier (2026-05-22). Prior fix _ensure_chat_listing_index worked
once but didn't guard against re-occurrence.

Schema now registers the index via:
  @@index([userId, archivedAt, lastMessageAt(sort: Desc, nulls: Last)])

Prisma 5.5+ supports the 'nulls' keyword — that's the breakthrough.
Future migrate dev runs see the index as part of schema → won't
generate spurious DROP statements.

Migration uses CREATE INDEX IF NOT EXISTS — idempotent on DBs that
have it, restorative on DBs where the auto-DROP chain landed.

Restores 2 failing chat.migration.smoke tests (5/5 now green).

Prior restoration migrations (_restore_chat_listing_index,
_ensure_chat_listing_index) left in place — needed for fresh-clone
lexical replay correctness."
```

---

## Final verification

After committing, one more sanity sweep:

- [ ] **Confirm no stray regression_check migration directory:**

```bash
ls apps/api/prisma/migrations/ | grep regression_check
```

Expected: no output. If present, delete via `rm -rf` and amend commit (but should be caught at Step 1.9).

- [ ] **Confirm git log shows exactly 2 files changed:**

```bash
git show HEAD --stat | tail -5
```

Expected: `apps/api/prisma/schema.prisma` (3-5 lines diff) + new `apps/api/prisma/migrations/<timestamp>_chat_listing_index_in_schema/migration.sql` (~6 lines new).
