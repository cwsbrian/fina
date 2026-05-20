# Plan 2-chat-user-scope — chat threads owned by user, lazy workspace binding

**Date:** 2026-05-20
**Status:** Spec
**Sub-plan of:** Phase 2 (Magic Ritual). Foundation refactor that the
follow-up Plan 2B (daily brief) builds on. The brief landing rule is
the design driver — see §4.

---

## 1. Goal

Move chat threads from being **owned by a workspace** to being **owned
by a user**, while preserving today's workspace-bound LLM behavior for
chat. The key insight is the **lazy binding** model: a new thread starts
with `workspaceId = null`, and the user's *first message* in the thread
commits it to a specific workspace.

This unlocks the Phase 2 daily brief: the brief targets `workspaceId IS
NULL` threads so it can be appended to a thread the user has never
replied to (or create a fresh null thread). Once the user replies, the
thread becomes workspace-bound for the rest of its life — and is
naturally ineligible for future briefs.

The "user has never sent a message to this thread" rule and the
"thread has no workspace bound" condition collapse into a single
column (`workspaceId IS NULL`), which is also the brief's selection
predicate. No separate `type` field or message-count query.

### What does NOT change

- The LLM dispatcher is still **workspace-scoped per turn**: it sees
  one workspace's data, writes target that workspace, audit rows are
  scoped to it.
- All write tools (`addTransaction`, `mapMerchantToCategory`,
  `addScheduledSpend`, etc.) still take `ctx.workspaceId` and run
  inside `withWorkspaceLock`. **No tool code changes** in this plan.
- The intent/confirmation flow (`1C-confirmation`) and audit log
  (`1C-audit`) are unchanged. They both key off `ctx.workspaceId`.

### What DOES change

- `ChatThread` schema: drop the workspaceId NOT NULL constraint, add
  `userId NOT NULL`.
- API surface: chat routes move from `/workspaces/:wsId/chat/*` to
  `/chat/*`. Workspace is no longer in the URL.
- Thread ownership is checked against `session.userId`, not workspace
  membership.
- User's first message body must include `workspaceId`. Backend binds
  the thread to it.
- Thread list returns the user's threads regardless of which workspace
  they ended up bound to (or whether bound at all).

### Out of scope

| Item | Why deferred |
|---|---|
| Daily brief generation (cron, LLM call, tier-aware content) | Plan 2B builds on this. This plan only creates the schema affordance (`workspaceId IS NULL`). |
| Multi-workspace per user (cross-workspace LLM, optional `workspaceId` arg on tools, system-prompt workspace list) | v2. v1 enforces 1 workspace per user implicitly (no UI/API to create more); design leaves hooks but the work itself is a separate plan. |
| Invite-acceptance flow changes (deleting personal workspace on accept) | Separate "single-workspace-enforcement" plan. Orthogonal to this refactor. |
| Frontend (web/mobile) updates to the new route paths | Frontend worktree handles those. This plan ships backend + types only. |
| Web chat UI | Not on roadmap (web is entry-only per master design §3). |
| Cross-workspace brief consolidation | Not meaningful in v1 (1 ws/user). v2 design problem. |

---

## 2. Schema

### 2.1 ChatThread

```prisma
model ChatThread {
  id            String    @id @default(cuid())
  userId        String    // NEW — every thread belongs to one user
  workspaceId   String?   // CHANGED — was required, now nullable
  title         String?
  lastMessageAt DateTime?
  archivedAt    DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  user      User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  workspace Workspace?    @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  messages  ChatMessage[]

  // Recency listing for the user's home: ORDER BY lastMessageAt DESC NULLS LAST.
  // Migration writes the index with NULLS LAST; @@index can't express that.
  @@map("chat_threads")
}
```

Index migration (raw SQL inside the Prisma migration). The existing
index from `20260516000000_multi_thread_chat` is `(workspaceId,
archivedAt, lastMessageAt DESC NULLS LAST)`; replace with the
user-scoped equivalent:

```sql
DROP INDEX IF EXISTS "chat_threads_workspaceId_archivedAt_lastMessageAt_idx";

CREATE INDEX "chat_threads_userId_archivedAt_lastMessageAt_idx"
  ON "chat_threads" ("userId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
```

The new index keeps `archivedAt` in the second slot so the listing
query (`WHERE userId = X AND archivedAt IS NULL ORDER BY
lastMessageAt DESC NULLS LAST`) hits it directly.

### 2.2 ChatMessage

No structural changes. `ChatMessage.threadId → ChatThread.id` still
holds. There is **no per-message workspaceId** — the message inherits
the thread's binding.

### 2.3 ScheduledSpend / RecurringExpense / Budget / Transaction

No changes. These remain workspace-scoped through their own
`workspaceId` columns.

### 2.4 No `type` field

The original Phase 2 sketch (`type: "adhoc" | "daily"`) is dropped
because `workspaceId IS NULL` already encodes "this thread is in
brief-eligible state". Adding a `type` column would duplicate the
signal and complicate the binding/reuse logic.

---

## 3. Migration

This is a pre-launch product with no real user data. The migration is
**destructive and intentionally so** — preserves zero rows.

```sql
-- 1. Purge dependent state.
--    chat_messages has ON DELETE CASCADE from chat_threads (existing FK),
--    so dropping threads automatically purges messages.
--    action_intents has `messageId TEXT` with NO FK (messageId is
--    only a soft reference), so its rows would survive — purge
--    explicitly to avoid dangling pointers.
--    audit_events is NOT chat-scoped — its rows describe tool calls
--    (categorizeTransaction, addTransaction, …) and are independent
--    of chat thread lifecycle. Do NOT delete audit rows.
DELETE FROM "action_intents";
DELETE FROM "chat_threads";  -- CASCADE deletes chat_messages

-- 2. Drop the old (workspaceId, archivedAt, lastMessageAt) index.
DROP INDEX IF EXISTS "chat_threads_workspaceId_archivedAt_lastMessageAt_idx";

-- 3. Schema change: add userId, make workspaceId nullable.
ALTER TABLE "chat_threads" ADD COLUMN "userId" TEXT NOT NULL;
ALTER TABLE "chat_threads"
  ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "chat_threads"
  ADD CONSTRAINT "chat_threads_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;

-- 4. Recreate index for the new listing shape.
CREATE INDEX "chat_threads_userId_archivedAt_lastMessageAt_idx"
  ON "chat_threads" ("userId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
```

Migration safety note: only `action_intents` and the chat thread/
message tables are purged. `audit_events` is left intact — those rows
record tool invocations (workspace-scoped) and remain meaningful
historically.

---

## 4. Lazy workspace binding — the core flow

### 4.1 Thread creation

```
POST /chat/threads
  Auth: session
  Body: { title?: string }
  Response: { thread: { id, userId, workspaceId: null, title, ... } }

  → INSERT INTO chat_threads(userId = session.userId, workspaceId = NULL, ...)
  → Return the row.
```

Threads are born **unbound**. There is no way to create a thread
already bound to a workspace — clients always go through "create →
send first message".

### 4.2 User's first message → binding

```
POST /chat/threads/:tid/messages
  Auth: session
  Body: { content: string, workspaceId: string }
  Response: { message, llmResponse, ... }

  1. Find thread by id; assert thread.userId === session.userId (403 if not).
  2. Verify session.user is a member of body.workspaceId
     (404 not_member if not).
  3. If thread.workspaceId IS NULL:
       UPDATE chat_threads SET workspaceId = body.workspaceId
         WHERE id = :tid AND workspaceId IS NULL;
       (Conditional update is the race guard — see §6.1.)
  4. Else if body.workspaceId !== thread.workspaceId:
       400 workspace_mismatch.
  5. Dispatch the message to the LLM with
       ctx = { workspaceId: thread.workspaceId, userId, role }
     — same as today.
```

Race: two parallel "first messages" against the same null thread.
The conditional `UPDATE ... WHERE workspaceId IS NULL` succeeds for
the first arrival; the second sees `thread.workspaceId` already set
and gets re-checked at step 4. The handler re-reads the thread after
the UPDATE attempt to decide.

### 4.3 Subsequent messages

`thread.workspaceId` is set. Body still includes `workspaceId` (so the
client doesn't need to track binding state explicitly), and it must
match. Mismatch returns 400 `workspace_mismatch`.

Rationale for requiring `workspaceId` in body even when bound: keeps
the API uniform, lets the server detect client-side drift (UI
showing a different workspace than the thread is bound to), and gives
v2 multi-workspace a natural place to evolve.

### 4.4 Daily brief (Plan 2B — not implemented here)

When the brief cron runs for a user (Plan 2B), it will:

```
1. SELECT * FROM chat_threads
     WHERE userId = :user
       AND workspaceId IS NULL
       AND archivedAt IS NULL
     ORDER BY lastMessageAt DESC NULLS FIRST, createdAt DESC
     LIMIT 1;
2. If a row exists → append brief message to it.
3. Else → INSERT a new ChatThread(userId, workspaceId=NULL),
   then append brief message.
```

The reuse-or-create rule produces:
- One brief-thread per user that keeps growing while the user ignores
  it (typical Lite user behavior).
- A new brief-thread the next morning after the user replies to a
  brief (their reply bound the previous thread to a workspace).

This plan does **not** implement the cron or LLM call. It only makes
the schema and routes shape-compatible with the rule above.

---

## 5. Route restructure

| Old | New | Behavior change |
|---|---|---|
| `POST /workspaces/:wsId/chat/threads` | `POST /chat/threads` | Body: `{ title? }`. No `workspaceId` (thread starts null). |
| `GET /workspaces/:wsId/chat/threads` | `GET /chat/threads` | Returns all of user's threads. `workspace` field per row (`null` for unbound). |
| `GET /workspaces/:wsId/chat/threads/:tid` | `GET /chat/threads/:tid` | Auth check: `thread.userId === session.userId`. |
| `PATCH /workspaces/:wsId/chat/threads/:tid` | `PATCH /chat/threads/:tid` | Rename only. Same body shape `{ title }`. |
| `DELETE /workspaces/:wsId/chat/threads/:tid` | `DELETE /chat/threads/:tid` | Soft archive (existing). |
| `POST /workspaces/:wsId/chat/threads/:tid/messages` | `POST /chat/threads/:tid/messages` | Body now requires `workspaceId`. See §4.2. |
| `POST /workspaces/:wsId/chat/threads/:tid/intents/:iid/consume` | `POST /chat/threads/:tid/intents/:iid/consume` | Verifies `intent.workspaceId === thread.workspaceId`. If thread is unbound, intent consumption is 400 (briefs don't issue intents). |

### 5.1 Auth model

Today: `requireWorkspaceMembership(wsId)` middleware reads URL param.

After: `requireSession()` only. The route handler then asserts
`thread.userId === session.userId` (for `:tid` routes) or just takes
the user from the session (for `/threads` collection routes).

Reused middleware: the existing session/cookie auth from
Better Auth — no rewrites.

### 5.2 Workspace membership check moves to the message body

For `POST /chat/threads/:tid/messages`, the handler must still verify
`session.user` is a member of `body.workspaceId` — otherwise the user
could bind a stranger's workspace to their own thread. The check is:

```ts
const membership = await prisma.membership.findFirst({
  where: { userId: session.userId, workspaceId: body.workspaceId },
  select: { role: true },
});
if (!membership) throw new HttpError(403, "not_member");
```

The `role` is then plumbed into the same `ToolContext.role` field as
today.

---

## 6. Concurrency + correctness

### 6.1 Race: two first-messages against a null thread

Handler logic (pseudocode):

```ts
async function handleFirstMessage(tid, body, session) {
  const thread = await prisma.chatThread.findFirst({
    where: { id: tid, userId: session.userId },
    select: { workspaceId: true },
  });
  if (!thread) throw 404;

  if (thread.workspaceId !== null) {
    if (thread.workspaceId !== body.workspaceId) throw 400 "workspace_mismatch";
    // Already bound; nothing to do here.
  } else {
    // Atomic bind — conditional UPDATE.
    const updated = await prisma.chatThread.updateMany({
      where: { id: tid, workspaceId: null },
      data: { workspaceId: body.workspaceId },
    });
    if (updated.count === 0) {
      // Lost the race; another first-message bound it. Re-check.
      const refetched = await prisma.chatThread.findFirstOrThrow({
        where: { id: tid }, select: { workspaceId: true },
      });
      if (refetched.workspaceId !== body.workspaceId)
        throw 400 "workspace_mismatch";
    }
  }
  // … continue with message dispatch using thread.workspaceId.
}
```

This avoids `withWorkspaceLock` overhead for the bind itself (the
locked tools run inside the LLM turn after the bind is committed).

### 6.2 Race: brief cron vs. user first-reply

Both attempt to mutate the same null thread:

- Brief cron writes a ChatMessage **only** (does not bind, never
  sets workspaceId).
- User first-reply binds workspaceId.

If a user reply lands during a brief generation:
- Brief cron has the thread id already; it'll INSERT a ChatMessage.
- User reply runs `UPDATE ... WHERE workspaceId IS NULL` → succeeds.
- Brief message and user message both end up in the thread, with the
  thread now bound. The user sees: [yesterday's brief][my reply].

Minor cosmetic edge: the brief that posted seconds before the user
reply is "the last brief in a now-bound thread", which means it'll
never be visited by a future brief (workspaceId no longer null). That
is the intended behavior — once the user engages, future briefs go
to a new null thread.

### 6.3 Audit log scoping

Today every `audit_events` row has `workspaceId NOT NULL`. After this
plan:
- LLM-turn audit rows still have `workspaceId` (from
  `thread.workspaceId` at the time of the turn).
- Brief-related audit (a Plan 2B concern) goes under the workspace
  the brief analyzed (the user's single membership in v1).
- We do **not** introduce nullable `workspaceId` on audit rows.

### 6.4 Intent consumption

`ActionIntent.workspaceId` (from 1C-confirmation) stays NOT NULL.
Intents are always created during an LLM turn that was bound to a
workspace. Consuming an intent requires `thread.workspaceId ===
intent.workspaceId`. Brief threads (`workspaceId IS NULL`) can't
issue intents — the LLM during a brief isn't a turn but a one-shot
text generation (Plan 2B detail).

---

## 7. Forward-compat hooks (NOT implemented here)

Marked here so the v2 multi-workspace plan has clear landing pads:

- **Optional `workspaceId` arg on read tools**: today every tool takes
  `ctx.workspaceId`. v2 read tools accept an optional override or an
  "all" mode. The current ctx shape `{ workspaceId, userId, role }`
  is preserved; v2 either adds `workspaceIds: string[]` or extends
  per-tool args.
- **System prompt workspace list**: v2 injects `"Your workspaces:
  [{id, name, role}, ...]"`. v1 system prompt unchanged.
- **Membership lookup helper**: §5.2's inline check is duplicated
  across the message route and any future cross-workspace route. v2
  may want a shared `assertMembership(userId, workspaceId)` helper —
  but adding it preemptively here is YAGNI.

The 1-workspace constraint is **not enforced by code** in this plan.
It's a product-level constraint (no UI to create more, no API path
publicized). A separate plan will tighten it via invite-accept
behavior and a hard reject in `POST /workspaces`.

---

## 8. Testing

### 8.1 New tests (chat-routes + threads service)

- `POST /chat/threads` creates a thread with `userId = session.userId`
  and `workspaceId = null`.
- `GET /chat/threads` returns the user's threads only; cross-user
  thread access via direct `:tid` returns 403.
- `POST /chat/threads/:tid/messages` first call binds the thread to
  `body.workspaceId` and stores the message.
- Second message in the same thread with mismatching
  `body.workspaceId` returns 400 `workspace_mismatch`.
- Message with `body.workspaceId` the user is not a member of returns
  403 `not_member`.
- Race: two concurrent first-messages — exactly one binds, the other
  either succeeds (matches) or 400s (mismatches). (Integration test
  via `Promise.all` + assert exactly one win.)
- `PATCH /chat/threads/:tid` and `DELETE /chat/threads/:tid` authorize
  by `userId`, not by membership.
- Intent consumption against a null-workspace thread returns 400.
- Intent consumption against a bound thread with mismatching intent
  workspaceId returns 400.

### 8.2 Removed tests

- All tests under `tests/chat.threads.workspace-scope.test.ts` (or
  equivalent) that asserted workspace-scoped thread listing are
  rewritten or deleted.
- The `tests/chat.routes.*` files that mounted at
  `/workspaces/:wsId/chat/*` shift to `/chat/*`.

### 8.3 Untouched tests

- Every tool test (`tests/chat.tools.*`) is unchanged — tools still
  see `ctx.workspaceId`.
- `tests/audit.service.test.ts`, `tests/intents.service.test.ts` —
  unchanged, both still key off `workspaceId`.
- `tests/cron.scheduler.test.ts` — unchanged (no chat impact).

---

## 9. Risks and known limitations

### 9.1 Client API churn

Every existing chat-route call from the frontend needs path + body
updates. The frontend worktree must merge before or alongside this
plan, otherwise the web/mobile chat UI breaks. Coordination is the
user's job — this plan ships backend types so the frontend's
TypeScript catches drift.

### 9.2 Intent consumption pre-binding

If the brief in Plan 2B ever issues an intent (it shouldn't — briefs
are text-only), the consume route would 400 on null-workspace thread.
That's a guard, not a bug. Briefs are spec'd as one-shot text.

### 9.3 Title generation (1E-title) timing

The current auto-title hook fires after the thread acquires a user
message. With the new binding flow, that's the same trigger — the
first user message both binds the workspace and provides the title
seed. No behavior change.

### 9.4 Cross-user thread access via guessed thread id

A logged-in user could try `GET /chat/threads/<guessed-tid>`. The
handler must check `thread.userId === session.userId` before
returning. Tests cover this.

### 9.5 Recency listing performance

Today: `chat_threads_workspaceId_archivedAt_lastMessageAt_idx`. After:
replaced with `chat_threads_userId_archivedAt_lastMessageAt_idx`. The
new query shape is strictly per-user (with `archivedAt IS NULL`
filter), so the index is correct for the listing in §5.

### 9.6 v2 friction not addressed

When v2 lifts the 1-workspace constraint, the lazy-binding model
needs a small extension: a brief might need to mention multiple
workspaces' data. Either (a) the brief picks one workspace and lands
in a null thread that gets bound to that workspace on reply, or (b)
the model evolves to support a "cross-workspace null thread". Neither
is decided here. v1 has 1 ws/user → not a v1 problem.

---

## 10. Success criteria

When the plan ships:
- A user can create a thread, send a first message with a
  `workspaceId`, and the thread becomes workspace-bound.
- Subsequent messages in that thread must use the same workspaceId.
- A user can have many threads, each bound to (potentially) different
  workspaces (in v2; in v1, all bound to their one workspace).
- Brief-eligible threads are findable via `WHERE workspaceId IS NULL`
  on the user's thread set — ready for Plan 2B.
- All existing tool / audit / intent / title flows still work
  unchanged; `ctx.workspaceId` semantics are identical to today.
- Tests pass; no test under `tests/chat.tools.*` was edited.
