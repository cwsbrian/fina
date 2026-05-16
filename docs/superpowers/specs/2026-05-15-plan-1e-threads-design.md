# Plan 1E-threads Design: Multi-Thread Chat + Wider Context Window

**Date:** 2026-05-15
**Status:** Final design, ready for implementation planning
**Scope:** Backend only (schema + API + context window). No UI work in this plan.

---

## 1. Goal

Enable multiple chat threads per workspace and widen the per-turn message history sent to the LLM. Today the chat foundation (Plan 1E-chat) locks each workspace to exactly one thread via `@@unique([workspaceId, type])` on `ChatThread` and caps history at 20 messages. This plan removes those limits.

This is a prerequisite for Plan 1E-search (`findTransactions`), whose large result lists would otherwise pollute the single shared thread. Once multi-thread ships, search and other heavy tools can live in their own threads without crowding out general conversation.

---

## 2. Existing context

Survey results (2026-05-15) on the current implementation:

- **Schema** (`apps/api/prisma/schema.prisma`): `ChatThread` carries a `type ChatThreadType @default(adhoc)` column and a `@@unique([workspaceId, type])` constraint. The `ChatThreadType` enum has `adhoc` and `daily`; `daily` is never written. `ChatMessage` is unchanged in scope.
- **Routes** (`apps/api/src/routes/chat.ts`): two endpoints. `POST /workspaces/:id/chat/message` upserts the thread by `(workspaceId, type="adhoc")` then runs a turn. `GET /workspaces/:id/chat/thread` upserts the thread and returns the latest 100 messages.
- **Turn** (`apps/api/src/chat/turn.ts`): loads `CHAT_HISTORY_LIMIT` (default 20) messages newest-first, reverses to chronological, calls Gemini with system prompt + financial context + tool definitions + history.
- **Context** (`apps/api/src/chat/context.ts`): workspace-wide aggregate only. Unchanged by this plan.
- **Tests**: `chat.routes.test.ts` asserts `count === 1` on second POST (upsert reuse). `chat.turn.test.ts` exercises history rehydration at the current count cap.
- **Frontend**: web and mobile have no chat UI yet. No client code depends on the existing route shape.
- **Tier gate**: only POST is gated to Pro today. GET is open.

---

## 3. Decisions taken during brainstorm

| Topic | Decision |
|---|---|
| Plan scope | Backend only. UI is a follow-up. |
| Thread identity | `id` (cuid) + nullable `title`. Drop `type` enum entirely. |
| Listing | Sort by `lastMessageAt DESC NULLS LAST, createdAt DESC`. Archived threads excluded by default. |
| Lifecycle | Explicit ChatGPT-style API. `POST /chat/threads` creates an empty thread; messages go to `POST /chat/threads/:tid/messages`. |
| History strategy | Hybrid: count cap (200) + token budget (400 000), whichever cuts first. |
| Token estimator | Local heuristic `Math.ceil(JSON.stringify(blocks).length / 4)`. No tokenizer dependency. |
| Soft delete | `DELETE` sets `archivedAt`. Archived threads are inaccessible (404) for message routes. |
| Backward compat | Existing single `adhoc` rows survive the migration. Their type column is dropped; `lastMessageAt` is backfilled from the latest message. |
| Tier gate | Mutating routes (POST, PATCH, DELETE) require Pro tier. GET routes preserve the current behavior: no tier gate, so a downgraded user can still read their history. |
| Role gate | POST/PATCH/DELETE require `editor` role (matches today's POST /chat/message). GET routes require `viewer`. |
| Streaming responses | Not in scope (Gemini call is request/response, like today). |

---

## 4. Schema changes

`ChatThread` after migration:

```prisma
model ChatThread {
  id            String    @id @default(cuid())
  workspaceId   String
  title         String?
  lastMessageAt DateTime?
  archivedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  workspace Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  messages  ChatMessage[]

  @@index([workspaceId, archivedAt, lastMessageAt(sort: Desc)])
  @@map("chat_threads")
}
```

Removed: `type` column, `@@unique([workspaceId, type])`, `ChatThreadType` enum.
Added: `title`, `lastMessageAt`, `archivedAt`, compound index.

`ChatMessage` and `ChatMessageRole`: unchanged.

### 4.1 Migration

Single migration `<timestamp>_multi_thread_chat`:

```sql
-- The previous @@unique was created by Prisma as a unique INDEX, not a table CONSTRAINT,
-- so drop the index (DROP CONSTRAINT would fail).
DROP INDEX "chat_threads_workspaceId_type_key";
ALTER TABLE "chat_threads" DROP COLUMN "type";
DROP TYPE "ChatThreadType";

-- Add nullable columns.
ALTER TABLE "chat_threads" ADD COLUMN "title" TEXT;
ALTER TABLE "chat_threads" ADD COLUMN "lastMessageAt" TIMESTAMP(3);
ALTER TABLE "chat_threads" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Backfill lastMessageAt from the most recent message per thread.
UPDATE "chat_threads" ct
SET "lastMessageAt" = (
  SELECT MAX("createdAt") FROM "chat_messages" WHERE "threadId" = ct.id
);

-- Index for list queries (workspace + archivedAt is null + sort desc).
CREATE INDEX "chat_threads_workspaceId_archivedAt_lastMessageAt_idx"
  ON "chat_threads"("workspaceId", "archivedAt", "lastMessageAt" DESC);
```

---

## 5. API surface

All routes are mounted under `/workspaces/:wsId/`. Authorization per route:

| Route | Role | Tier |
|---|---|---|
| POST /chat/threads | editor | Pro |
| POST /chat/threads/:tid/messages | editor | Pro |
| GET /chat/threads | viewer | — (no tier gate) |
| GET /chat/threads/:tid | viewer | — (no tier gate) |
| PATCH /chat/threads/:tid | editor | Pro |
| DELETE /chat/threads/:tid | editor | Pro |

Tier failures return 402 `upgrade_required`. Role failures bubble up from `requireWorkspaceContext` with its existing 403 code.

### 5.1 `POST /workspaces/:wsId/chat/threads`

Create an empty thread. No initial message — messages go through the messages route.

**Body:**
```ts
{ title?: string }  // optional, max length 200
```

**Response 201:**
```ts
{ thread: { id, title: string | null, createdAt: string, lastMessageAt: string | null, archivedAt: string | null } }
```

### 5.2 `POST /workspaces/:wsId/chat/threads/:tid/messages`

Send a user message and run a turn. Replaces the deprecated `POST /chat/message`.

**Body:**
```ts
{ text: string }  // min length 1, max length 4000 — preserved from the current POST /chat/message contract
```

**Response 200:**
```ts
{
  threadId: string,
  userMessage: { id, role: "user", blocks, createdAt },
  assistantMessage: { id, role: "assistant", blocks, createdAt },
  toolCalls: Array<{ toolName: string, args: unknown, result: unknown }>
}
```

**Errors:**
- 404 `thread_not_found` — thread missing, cross-workspace, or `archivedAt != null`. Same error code for all three to avoid leaking existence.
- 402 `upgrade_required` — tier gate.
- 500 `chat_provider_error` — Gemini failure (unchanged).

**Side effect**: `chatThread.lastMessageAt` updated to `now()` in the same transaction as the message insertions. Both the user message and the assistant message bump it; in practice the assistant insert is the last write so `lastMessageAt` ends up at the assistant timestamp.

### 5.3 `GET /workspaces/:wsId/chat/threads`

List threads in the workspace.

**Query:**
```ts
{ include_archived?: boolean,  // default false
  limit?: number }              // default 50, max 100
```

**Response 200:**
```ts
{
  threads: Array<{
    id: string,
    title: string | null,
    lastMessageAt: string | null,
    archivedAt: string | null,
    createdAt: string,
    messageCount: number,
    firstMessagePreview: string | null  // first user message text, truncated to 100 chars
  }>
}
```

**Ordering:** `lastMessageAt DESC NULLS LAST, createdAt DESC, id DESC`. Deterministic for ties.

`firstMessagePreview` is computed by reading the first user message ordered by `createdAt ASC`, scanning its `blocks` array for the first element whose `type === "text"`, and using that block's `markdown`. Null if no user messages or no text block. Truncation: first 100 characters, no ellipsis.

### 5.4 `GET /workspaces/:wsId/chat/threads/:tid`

Fetch one thread with its messages.

**Response 200:**
```ts
{
  thread: { id, title, lastMessageAt, archivedAt, createdAt },
  messages: Array<{ id, role, blocks, createdAt }>  // chronological, most recent 100
}
```

**Errors:**
- 404 `thread_not_found` — missing, cross-workspace. Archived threads ARE returned by this route (so UI can show history); only the messages route blocks archived.

Message count cap of 100 keeps payload bounded. UI-side pagination (older-than cursor) ships in a follow-up.

### 5.5 `PATCH /workspaces/:wsId/chat/threads/:tid`

Rename or clear the title.

**Body:**
```ts
{ title: string | null }  // string max 200, or null to clear
```

**Response 200:** updated `thread` object.

**Errors:** 404 if missing/cross-workspace. Archived threads CAN be renamed (lets UI tidy up after archive).

### 5.6 `DELETE /workspaces/:wsId/chat/threads/:tid`

Soft delete by setting `archivedAt`.

**Response:** 204 No Content.

**Idempotent:** repeated calls return 204 even if already archived. 404 only when the thread doesn't exist or belongs to another workspace.

### 5.7 Removed routes

- `POST /workspaces/:id/chat/message` — removed entirely. No backward-compat shim. No client depends on it.
- `GET /workspaces/:id/chat/thread` — removed. Use `GET /chat/threads` or `GET /chat/threads/:tid`.

---

## 6. Context window strategy

### 6.1 Env vars

Add to `apps/api/src/env.ts` Zod schema, mirroring the existing optional + use-site-default pattern (`CHAT_MODEL`, `CHAT_HISTORY_LIMIT`, `CHAT_MAX_TOOL_CALLS_PER_TURN`) so existing test code that constructs `Env` literals doesn't break:

```ts
CHAT_HISTORY_LIMIT_MESSAGES: z.coerce.number().int().positive().optional(),
CHAT_HISTORY_BUDGET_TOKENS:  z.coerce.number().int().positive().optional(),
```

Defaults are applied at the use site in `turn.ts`:

```ts
const HISTORY_LIMIT_MESSAGES = env.CHAT_HISTORY_LIMIT_MESSAGES ?? 200;
const HISTORY_BUDGET_TOKENS  = env.CHAT_HISTORY_BUDGET_TOKENS  ?? 400_000;
```

Remove: `CHAT_HISTORY_LIMIT` (the old single cap) from `env.ts` and from `turn.ts`.

### 6.2 Token estimator

`apps/api/src/chat/token-estimate.ts`:

```ts
// Cheap heuristic: 4 chars ≈ 1 token. Used as a safety valve against
// pathological tool-result payloads. NOT for billing or precise budgeting.
export function estimateMessageTokens(blocks: unknown): number {
  return Math.ceil(JSON.stringify(blocks).length / 4);
}
```

### 6.3 Algorithm

In `apps/api/src/chat/turn.ts`:

1. Fetch up to `CHAT_HISTORY_LIMIT_MESSAGES` messages from the target thread, ordered by `createdAt DESC`. This is the outer count cap.
2. Walk the result newest → oldest, accumulating `estimateMessageTokens(msg.blocks)` into a running sum.
3. Stop when adding the next message would push the sum past `CHAT_HISTORY_BUDGET_TOKENS`. Drop that message and everything older.
4. **Single-message overflow guard**: if the newest message alone exceeds the budget, keep it anyway (cutting it leaves zero context).
5. Reverse the selected slice to chronological order and pass it to Gemini.

The current logic already does step 1 with a smaller cap and step 5; this plan replaces step 1's constant and inserts steps 2–4 between fetch and reverse.

### 6.4 Defaults rationale

- 200 messages cap is a generous baseline; the prior 20 was a placeholder. Real chats rarely exceed this in normal use.
- 400 000 tokens is roughly 40% of Gemini 2.5 Flash Lite's 1 M context window, leaving 60% for system prompt + tool defs + financial context + the user's new message + assistant response. Both knobs are env-tunable per environment.

---

## 7. File structure changes

Created:
- `apps/api/src/chat/threads.ts` — service module exporting `create`, `list`, `findOwned`, `patch`, `archive`.
- `apps/api/src/chat/token-estimate.ts` — single function above.
- `apps/api/tests/chat.threads.test.ts` — service-level tests.
- `apps/api/tests/chat.token-estimate.test.ts` — heuristic tests.

Modified:
- `apps/api/prisma/schema.prisma` — see §4.
- `apps/api/prisma/migrations/<ts>_multi_thread_chat/migration.sql` — see §4.1.
- `apps/api/src/env.ts` — replace `CHAT_HISTORY_LIMIT` with the two new env vars in §6.1.
- `apps/api/src/routes/chat.ts` — rewritten to the five routes in §5. The old `upsert by (workspaceId, type)` logic is removed.
- `apps/api/src/chat/turn.ts` — history selection replaced per §6.3. Add `lastMessageAt` update in the message-write transaction.
- `apps/api/tests/chat.routes.test.ts` — remove the `count === 1` upsert assertion and re-cover the new routes.
- `apps/api/tests/chat.turn.test.ts` — update history-limit cases; add a token-budget cut case.

No changes:
- `apps/api/src/chat/dispatcher.ts`, `gemini-adapter.ts`, `context.ts`, all 11 tool files, the tool registry.

---

## 8. Error handling rules

- Cross-workspace `threadId` access on any thread route → 404 `thread_not_found`. Use the same code as missing-thread to avoid existence leaks.
- Archived thread accessed via the messages route → 404 `thread_not_found`. Archived threads ARE accessible via the `GET /threads/:tid` and `PATCH` routes (so UI can tidy up).
- Repeated `DELETE` on an already-archived thread → 204, idempotent. 404 only when the thread row doesn't exist at all.
- `title` longer than 200 chars → 400 from Zod.
- `text` empty OR longer than 4000 chars → 400 from Zod.
- Gemini failure → 500 `chat_provider_error`, unchanged.
- Free tier on a mutating chat route (POST/PATCH/DELETE) → 402 `upgrade_required`. GET routes do not check tier.
- Insufficient role → 403 via `requireWorkspaceContext` (existing behavior).

---

## 9. Testing plan

### 9.1 Unit / service tests

`apps/api/tests/chat.threads.test.ts`:
- Create returns a row with the right workspaceId.
- List returns multiple threads, sorted by `lastMessageAt DESC NULLS LAST`.
- List includes/excludes archived per the flag.
- Cross-workspace `findOwned` returns null (treated as 404 upstream).
- `patch` updates title; null clears it.
- `archive` sets `archivedAt`; second call is no-op.

`apps/api/tests/chat.token-estimate.test.ts`:
- Empty blocks → 0.
- Pure text block → roughly `chars / 4`.
- JSON tool-call payload → estimates rise with payload size.
- Stable across two calls on the same input.

### 9.2 Route tests (`chat.routes.test.ts` rewritten)

- POST threads: creates row, 201, returns id.
- POST messages: 200 with tool calls, `lastMessageAt` advanced.
- POST messages 404 on cross-workspace or archived thread.
- POST messages 402 for free tier.
- POST messages 403 for viewer-role member.
- POST messages 400 when `text` is empty or longer than 4000 chars.
- PATCH/DELETE 403 for viewer-role member.
- GET threads: returns the two threads sorted, excludes archived.
- GET threads with `?include_archived=true` includes archived.
- GET threads `firstMessagePreview` is the truncated first user text.
- GET threads/:tid: returns thread + messages chronological.
- GET threads/:tid: 404 cross-workspace.
- GET threads/:tid: archived thread returns 200 (still readable).
- PATCH renames; PATCH with null clears.
- DELETE archives; second DELETE returns 204.
- DELETE on non-existent thread: 404.

### 9.3 Turn tests (`chat.turn.test.ts` extended)

- History under both caps → all messages passed in chronological order.
- History above the count cap → newest `CHAT_HISTORY_LIMIT_MESSAGES` selected.
- History under the count cap but above the token budget → cut at token budget, chronological order preserved.
- Single message larger than the token budget → that message is still sent (no empty history).
- Multiple threads in the same workspace do not see each other's history.

### 9.4 Migration test

Apply migration on a snapshot that has one `adhoc` thread with N messages. Assert post-migration:
- The row still exists with the same `id`.
- `type` column is gone.
- `lastMessageAt` equals `MAX(createdAt)` from `chat_messages` for that thread.
- A second thread can be created with the same `workspaceId` without conflict.

### 9.5 E2E

`e2e/plan-1e-threads.spec.ts` (skip-guarded on DB + `GEMINI_API_KEY`):
- Sign-up Pro user, create two threads, send a message to each, fetch each thread, assert messages are isolated.
- Archive one thread, attempt to send a message → 404. Confirm GET still works.

---

## 10. Acceptance criteria

This phase is complete when:

- `chat_threads.type` and `ChatThreadType` are gone from schema and DB.
- `chat_threads` has nullable `title`, `lastMessageAt`, `archivedAt`, and the new compound index.
- A workspace can hold 2+ threads with no uniqueness conflict.
- The five new routes (POST threads, POST messages, GET list, GET one, PATCH, DELETE) work as specified.
- `POST /chat/message` and `GET /chat/thread` are removed; no backward-compat shim.
- Mutating chat routes (POST, PATCH, DELETE) require Pro tier and `editor` role. GET routes require `viewer` role and are not tier-gated.
- Cross-workspace thread access returns 404 with `thread_not_found`.
- Archived thread message-send returns 404 with `thread_not_found`.
- `CHAT_HISTORY_LIMIT_MESSAGES` (use-site default 200) and `CHAT_HISTORY_BUDGET_TOKENS` (use-site default 400 000) are honored; the older `CHAT_HISTORY_LIMIT` is gone. Both env keys are optional in the Env schema; defaults applied in `turn.ts` via `?? value`.
- History selection cuts at whichever cap hits first and is always passed chronologically.
- `lastMessageAt` is updated in the same transaction as message inserts.
- Existing `adhoc` thread rows survive the migration with backfilled `lastMessageAt`.
- All new and updated tests pass.
- The 11 existing chat tools work unchanged.

---

## 11. Excluded scope

The following are explicitly NOT in this plan:

- Any chat UI (web or mobile). Follow-up Plan 1E-UI.
- LLM-generated thread titles (auto-summary). Follow-up.
- Thread search.
- Per-thread tool usage metrics.
- Cursor or infinite-scroll pagination on the messages endpoint.
- The `findTransactions` chat tool. Captured in `project_plan_1e_search_decisions.md`; will resume after this plan ships.
- Plaid date-only storage policy (Plan 1E-time).
- The two pre-existing TypeScript errors in `apps/api/src/chat/turn.ts` (from Plan 1E-chat). Separate cleanup commit.

---

## 12. Follow-up candidates after 1E-threads

- **Plan 1E-search**: `findTransactions` chat tool with filters (merchant, date range, amount, category, account) and `totalCount`/`hasMore` pagination. Filter scope and pagination strategy were settled during the 2026-05-15 brainstorm before this plan was branched off; see the memo at `project_plan_1e_search_decisions.md`.
- **Plan 1E-UI**: web + mobile chat UI consuming the multi-thread API. Includes thread sidebar, create/select/rename/archive, rich rendering for the 11 tool result shapes, and likely infinite-scroll pagination on messages.
- **Plan 1E-time**: Plaid date-only storage policy fix + retroactive timezone correctness across all existing transaction APIs.
- **Auto thread titles**: LLM call on the first user message to generate a title, fill `title` field.
