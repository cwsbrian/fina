# Categorize Inbox + Home Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/categorize/inbox` screen for batch handling of needs-confirmation transactions and reorganize Home around an "Action Items" section that surfaces the user's pending work (bank reconnect, unread Fina, categorize backlog, trial expiring, invites, onboarding).

**Architecture:** Mobile gets two new screens (`/categorize/inbox`, `/workspace/incoming`) plus a redesigned Home with `ActionItemCard` + Spend card. Backend adds `chat_threads.lastReadAt` column, `POST /chat/threads/:id/read`, `POST /workspaces/:id/transactions/:txId/dismiss-category`, and a `?needsReview=true` filter on transactions list. `GET /chat/threads` gains an `unreadCount` field calculated via a single GROUP BY query (no N+1).

**Tech Stack:** Fastify + Prisma 5 (Postgres) on the API, Expo SDK 54 React Native on mobile, `@fina/shared` for cross-app types, existing `apiFetch` client + `BoolFlag` zod pattern from `apps/api/src/routes/transactions.ts:25-32`. Tests live in `apps/api/tests/<name>.test.ts` using vitest + canonical helpers (`tests/helpers/auth.ts`, `tests/helpers/db.ts`).

**Spec:** `docs/superpowers/specs/2026-05-25-categorize-inbox-and-home-design.md`

**Prerequisites:** Categorization overhaul (`docs/superpowers/specs/2026-05-25-categorization-overhaul-design.md`) is shipped — `User.categorizationMode`, `TransactionAllocation.needsConfirmation`/`dismissedUntil`, `POST /confirm-category`, `POST /snooze-category`, `applyManualCategorize` all already exist.

---

## File structure

**Create:**
- `apps/mobile/app/categorize/inbox.tsx` — Categorize Inbox screen
- `apps/mobile/app/workspace/incoming.tsx` — Pending invites screen
- `apps/mobile/src/home/ActionItemCard.tsx` — reusable Home action item card
- `apps/mobile/src/home/SpendCard.tsx` — "This month" spend card
- Test files (all in `apps/api/tests/`):
  - `apps/api/tests/chat.read.test.ts`
  - `apps/api/tests/chat.unread-count.test.ts`
  - `apps/api/tests/transactions.dismiss-category.test.ts`
  - `apps/api/tests/transactions.needs-review-query.test.ts`

**Modify:**
- `libs/shared/src/dto/chat.ts` — add `lastReadAt` + `unreadCount` to ChatThreadDTO (or wherever the listing response shape lives — check existing first)
- `apps/api/prisma/schema.prisma` — `ChatThread.lastReadAt` column
- `apps/api/prisma/migrations/<ts>_chat_thread_lastreadat/migration.sql` — raw SQL ADD COLUMN
- `apps/api/src/routes/chat.ts` — (a) add `POST /chat/threads/:tid/read` handler (b) extend local `serializeThread` (line 18) with `lastReadAt` (c) extend `GET /chat/threads` to include `unreadCount` via single GROUP BY query
- `apps/api/src/routes/transactions.ts` — add `needsReview: BoolFlag` to `QuerySchema` + apply filter in the existing IIFE at line 142-149; add `POST /workspaces/:id/transactions/:txId/dismiss-category` route
- `apps/api/src/telemetry/categorize.ts` — extend `emitCategorizeConfirmed` action union with `"dismiss-auto"`
- `apps/mobile/app/(tabs)/index.tsx` — full Home redesign
- `apps/mobile/app/(tabs)/more.tsx` — add "Review queue" row in AI group
- `apps/mobile/app/(tabs)/chat.tsx` — call `POST /chat/threads/:tid/read` when `params.thread` becomes set (existing single-file chat tab with `useLocalSearchParams<{ thread?: string }>`)

**Test:**
- `apps/api/tests/chat.read.test.ts` — POST /read endpoint
- `apps/api/tests/chat.unread-count.test.ts` — GET /chat/threads response includes unreadCount with correct values
- `apps/api/tests/transactions.dismiss-category.test.ts` — new endpoint
- `apps/api/tests/transactions.needs-review-query.test.ts` — `?needsReview=true` filter

---

## Task 1: Shared lib — ChatThreadDTO + transactions query types

**Files:**
- Modify: `libs/shared/src/dto/chat.ts` (or wherever ChatThreadDTO + thread list response live — check via grep first)

- [ ] **Step 1: Locate ChatThreadDTO + list response type**

```bash
grep -n "ChatThreadDTO\|threads:" libs/shared/src/dto/chat.ts | head -10
```

Read the existing types. The current shape (verified at session start) is `ChatThreadDTO = { id, userId, workspaceId, title, lastMessageAt, archivedAt, createdAt, updatedAt }`. The list response from `GET /chat/threads` extends each row with `messageCount` and `firstMessagePreview` — that response shape may live in this file or be inlined in the route handler.

- [ ] **Step 2: Extend `ChatThreadDTO` with two new fields**

Add to `ChatThreadDTO`:

```ts
  /** ISO 8601 timestamp the user last marked this thread as read, or null
   *  if the thread has never been opened. */
  lastReadAt: string | null;
  /** Server-computed count of assistant messages in this thread whose
   *  createdAt is after lastReadAt (or all assistant messages if
   *  lastReadAt is null). user/tool role messages are NOT counted. */
  unreadCount: number;
```

- [ ] **Step 3: Build shared lib**

```bash
pnpm -F @fina/shared build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add libs/shared/src/dto/chat.ts
git commit -m "feat(shared): ChatThreadDTO.lastReadAt + .unreadCount"
```

---

## Task 2: Prisma migration — `chat_threads.lastReadAt`

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_chat_thread_lastreadat/migration.sql`

- [ ] **Step 1: Add field to schema**

In `apps/api/prisma/schema.prisma`, find `model ChatThread`. Add a new line after `lastMessageAt`:

```prisma
  lastReadAt    DateTime?
```

- [ ] **Step 2: Generate empty migration**

```bash
pnpm --filter @fina/api exec prisma migrate dev --create-only --name chat_thread_lastreadat
```

A new migration directory appears under `apps/api/prisma/migrations/<TIMESTAMP>_chat_thread_lastreadat/migration.sql`. Open it.

- [ ] **Step 3: Verify generated SQL**

Should contain:

```sql
ALTER TABLE "chat_threads" ADD COLUMN "lastReadAt" TIMESTAMP(3);
```

No edits needed if Prisma generated only this line.

- [ ] **Step 4: Apply migration**

```bash
pnpm --filter @fina/api exec prisma migrate dev
```

Prisma client regenerates.

- [ ] **Step 5: Sanity typecheck**

```bash
pnpm -F @fina/api exec tsc --noEmit -p .
```

Expected: only pre-existing unrelated errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(db): ChatThread.lastReadAt nullable column"
```

---

## Task 3: Backend — `POST /chat/threads/:tid/read`

**Files:**
- Modify: `apps/api/src/routes/chat.ts` (add handler to existing file — no new file)
- Create: `apps/api/tests/chat.read.test.ts`

- [ ] **Step 1: Read existing `apps/api/src/routes/chat.ts` to find the right insertion point**

Find the line registering `app.patch("/chat/threads/:tid", ...)` (around line 140). The new read endpoint goes right after that handler so all `/chat/threads/:tid/*` routes sit together.

- [ ] **Step 2: Add the handler in `apps/api/src/routes/chat.ts`**

```ts
  app.post<{ Params: { tid: string } }>("/chat/threads/:tid/read", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const updated = await prisma.chatThread.updateMany({
        where: { id: req.params.tid, userId: session.userId },
        data: { lastReadAt: new Date() },
      });
      if (updated.count === 0) {
        return reply.code(404).send({ error: "thread_not_found" });
      }
      return reply.code(200).send({ ok: true });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
```

`updateMany` + a `where: { id, userId }` clause does both the auth check and the update in one round-trip — owner-only by construction.

- [ ] **Step 3: Write tests**

```ts
// apps/api/tests/chat.read.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();
let app: Awaited<ReturnType<typeof buildApp>>;
let counter = 0;

beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup() {
  const u = await signUpAndGetCookie(app, { email: `cr-${counter++}@x.com`, name: "T" });
  const thread = await prisma.chatThread.create({
    data: { userId: u.userId, workspaceId: null },
  });
  return { cookie: u.cookie, userId: u.userId, threadId: thread.id };
}

describe("POST /chat/threads/:tid/read", () => {
  it("marks thread as read (sets lastReadAt)", async () => {
    const { cookie, threadId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/chat/threads/${threadId}/read`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(200);
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.lastReadAt).not.toBeNull();
  });

  it("returns 404 for thread owned by another user", async () => {
    const { threadId } = await setup();
    const other = await signUpAndGetCookie(app, { email: `cr-other-${counter++}@x.com`, name: "B" });
    const r = await app.inject({
      method: "POST",
      url: `/chat/threads/${threadId}/read`,
      headers: { cookie: other.cookie },
    });
    expect(r.statusCode).toBe(404);
  });

  it("idempotent — second call updates lastReadAt again", async () => {
    const { cookie, threadId } = await setup();
    await app.inject({ method: "POST", url: `/chat/threads/${threadId}/read`, headers: { cookie } });
    const first = await prisma.chatThread.findUnique({ where: { id: threadId } });
    await new Promise((r) => setTimeout(r, 20));
    const r = await app.inject({ method: "POST", url: `/chat/threads/${threadId}/read`, headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const second = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(second!.lastReadAt!.getTime()).toBeGreaterThan(first!.lastReadAt!.getTime());
  });
});
```

- [ ] **Step 4: Run tests**

```bash
pnpm -F @fina/api exec vitest run tests/chat.read.test.ts
```

Expected: 3/3 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.read.test.ts
git commit -m "feat(api): POST /chat/threads/:tid/read marks thread as read"
```

---

## Task 4: Backend — `GET /chat/threads` returns `unreadCount`

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Create: `apps/api/tests/chat.unread-count.test.ts`

- [ ] **Step 1: Extend the list handler with the unread aggregate**

In `apps/api/src/routes/chat.ts`, find `app.get("/chat/threads", ...)`. The existing aggregate uses `prisma.chatMessage.groupBy` for messageCount + `findMany` for firstMessagePreview. Add a THIRD parallelizable query for unread counts.

After the existing `firstUserMessages` query, add:

```ts
      // Unread assistant-message count per thread.
      // Single grouped raw query — uses thread.lastReadAt to filter; if NULL,
      // all assistant messages count as unread.
      const unreadRows = threadIds.length === 0 ? [] : await prisma.$queryRaw<Array<{
        threadId: string;
        cnt: bigint;
      }>>`
        SELECT m."threadId" AS "threadId", COUNT(*)::bigint AS cnt
        FROM "chat_messages" m
        JOIN "chat_threads" t ON t.id = m."threadId"
        WHERE m."threadId" = ANY(${threadIds}::text[])
          AND m.role = 'assistant'
          AND (t."lastReadAt" IS NULL OR m."createdAt" > t."lastReadAt")
        GROUP BY m."threadId"
      `;
      const unreadByThread = new Map(unreadRows.map((r) => [r.threadId, Number(r.cnt)]));
```

Then extend the response mapping:

```ts
      return {
        threads: threads.map((t) => ({
          ...serializeThread(t),
          messageCount: countByThread.get(t.id) ?? 0,
          firstMessagePreview: previewByThread.get(t.id) ?? null,
          unreadCount: unreadByThread.get(t.id) ?? 0,
        })),
      };
```

- [ ] **Step 2: Extend `serializeThread` to expose `lastReadAt`**

`serializeThread` is a local function in `apps/api/src/routes/chat.ts:18`. Its input type has explicit fields; both type and body need updating.

Replace the existing function:

```ts
function serializeThread(t: {
  id: string; userId: string; workspaceId: string | null; title: string | null;
  lastMessageAt: Date | null; archivedAt: Date | null;
  createdAt: Date; updatedAt: Date;
  lastReadAt: Date | null;
}) {
  return {
    id: t.id,
    userId: t.userId,
    workspaceId: t.workspaceId,
    title: t.title,
    lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    lastReadAt: t.lastReadAt?.toISOString() ?? null,
  };
}
```

Prisma's `ChatThread` model (after Task 2 migration) automatically includes `lastReadAt` in `findMany` results, so no callsite changes needed beyond this serializer update.

- [ ] **Step 3: Tests**

```ts
// apps/api/tests/chat.unread-count.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();
let app: Awaited<ReturnType<typeof buildApp>>;
let counter = 0;

beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup() {
  const u = await signUpAndGetCookie(app, { email: `uc-${counter++}@x.com`, name: "T" });
  const thread = await prisma.chatThread.create({ data: { userId: u.userId, workspaceId: null } });
  return { cookie: u.cookie, userId: u.userId, threadId: thread.id };
}

async function addMsg(threadId: string, role: "assistant" | "user" | "tool", at?: Date) {
  await prisma.chatMessage.create({
    data: {
      threadId,
      role,
      blocks: [{ type: "text", markdown: "x" }],
      createdAt: at ?? new Date(),
    },
  });
}

describe("GET /chat/threads — unreadCount", () => {
  it("lastReadAt=null → all assistant messages count as unread", async () => {
    const { cookie, threadId } = await setup();
    await addMsg(threadId, "assistant");
    await addMsg(threadId, "assistant");
    const r = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    const t = body.threads.find((x: { id: string }) => x.id === threadId);
    expect(t.unreadCount).toBe(2);
  });

  it("filters out user/tool role messages", async () => {
    const { cookie, threadId } = await setup();
    await addMsg(threadId, "assistant");
    await addMsg(threadId, "user");
    await addMsg(threadId, "tool");
    const r = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    const body = JSON.parse(r.body);
    const t = body.threads.find((x: { id: string }) => x.id === threadId);
    expect(t.unreadCount).toBe(1);
  });

  it("lastReadAt set in past → only messages after that count", async () => {
    const { cookie, threadId } = await setup();
    const past = new Date(Date.now() - 60_000);
    await addMsg(threadId, "assistant", new Date(past.getTime() - 1000)); // before
    await prisma.chatThread.update({ where: { id: threadId }, data: { lastReadAt: past } });
    await addMsg(threadId, "assistant", new Date(past.getTime() + 1000)); // after
    const r = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    const body = JSON.parse(r.body);
    const t = body.threads.find((x: { id: string }) => x.id === threadId);
    expect(t.unreadCount).toBe(1);
  });

  it("includes lastReadAt as ISO string in response", async () => {
    const { cookie, threadId } = await setup();
    await prisma.chatThread.update({ where: { id: threadId }, data: { lastReadAt: new Date("2026-05-01T00:00:00Z") } });
    const r = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    const body = JSON.parse(r.body);
    const t = body.threads.find((x: { id: string }) => x.id === threadId);
    expect(typeof t.lastReadAt).toBe("string");
    expect(t.lastReadAt).toContain("2026-05-01");
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm -F @fina/api exec vitest run tests/chat.unread-count.test.ts
```

Expected: 4/4 PASS.

```bash
git add apps/api/src/routes/chat.ts apps/api/src/chat/threads.ts apps/api/tests/chat.unread-count.test.ts
git commit -m "feat(api): GET /chat/threads returns unreadCount + lastReadAt"
```

---

## Task 5: Backend — `POST /workspaces/:id/transactions/:txId/dismiss-category`

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Create: `apps/api/tests/transactions.dismiss-category.test.ts`

- [ ] **Step 1: Extend telemetry action union in `apps/api/src/telemetry/categorize.ts`**

Current `emitCategorizeConfirmed` accepts `action: "confirm" | "edit" | "snooze"`. Add `"dismiss-auto"`:

```ts
export function emitCategorizeConfirmed(args: {
  workspaceId: string;
  source: "mapping" | "history" | "ai" | "manual";
  action: "confirm" | "edit" | "snooze" | "dismiss-auto";
}) {
  logInfo({ event: "categorize.confirmed", ...args }, "categorize.confirmed");
}
```

(Spec mentions `skip-client` as a v2 client-side telemetry — no backend wiring needed for v1.)

- [ ] **Step 2: Add handler in `routes/transactions.ts`**

Place right after `POST /snooze-category` (the categorize-overhaul-added one). Pattern mirrors `snooze-category` but writes a different field + emits dismiss-auto telemetry:

```ts
  app.post<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId/dismiss-category",
    async (req, reply) => {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== req.params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tx = await prisma.transaction.findFirst({
        where: { id: req.params.txId, workspaceId: ctx.membership.workspaceId, removedAt: null },
        select: { id: true },
      });
      if (!tx) return reply.code(404).send({ error: "transaction_not_found" });

      await prisma.transactionAllocation.updateMany({
        where: { transactionId: tx.id },
        data: { needsConfirmation: false },
      });

      emitCategorizeConfirmed({
        workspaceId: ctx.membership.workspaceId,
        source: "ai", // approximation — actual source may vary, snooze pattern
        action: "dismiss-auto",
      });
      return reply.code(200).send({ ok: true });
    },
  );
```

Make sure `emitCategorizeConfirmed` is imported at the top:

```ts
import { emitCategorizeConfirmed } from "../telemetry/categorize.js";
```

(Likely already imported from previous categorize work.)

`dismissedUntil` is NOT touched — semantically different from `snooze-category`.

- [ ] **Step 2: Tests**

```ts
// apps/api/tests/transactions.dismiss-category.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();
let app: Awaited<ReturnType<typeof buildApp>>;
let counter = 0;

beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup() {
  const u = await signUpAndGetCookie(app, { email: `dc-${counter++}@x.com`, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "A", type: "depository" } });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "DismissTestCat" } });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      merchantRaw: "STARBUCKS", merchantNormalized: "starbucks",
      amount: "5.00", occurredAt: new Date(),
      source: "plaid", rawData: {},
      allocations: { create: { amount: "5.00", categoryId: cat.id, source: "ai", needsConfirmation: true } },
    },
  });
  return { cookie: u.cookie, wsId, txId: tx.id };
}

describe("POST /workspaces/:id/transactions/:txId/dismiss-category", () => {
  it("sets needsConfirmation=false without changing dismissedUntil", async () => {
    const { cookie, wsId, txId } = await setup();
    // Pre-set a dismissedUntil to confirm it is preserved.
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.transactionAllocation.updateMany({ where: { transactionId: txId }, data: { dismissedUntil: future } });

    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/dismiss-category`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(200);
    const alloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: txId } });
    expect(alloc?.needsConfirmation).toBe(false);
    expect(alloc?.dismissedUntil?.getTime()).toBe(future.getTime());
  });

  it("returns 404 for missing tx", async () => {
    const { cookie, wsId } = await setup();
    const r = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/nope/dismiss-category`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm -F @fina/api exec vitest run tests/transactions.dismiss-category.test.ts
```

Expected: 2/2 PASS.

```bash
git add apps/api/src/routes/transactions.ts apps/api/tests/transactions.dismiss-category.test.ts
git commit -m "feat(api): POST /dismiss-category — Auto-mode permanent dismiss"
```

---

## Task 6: Backend — `?needsReview=true` filter on transactions list

**Files:**
- Modify: `apps/api/src/routes/transactions.ts`
- Create: `apps/api/tests/transactions.needs-review-query.test.ts`

- [ ] **Step 1: Extend `QuerySchema` with `needsReview`**

In `apps/api/src/routes/transactions.ts`, find the `QuerySchema = z.object({ ... })` block (around line 60). Add:

```ts
  needsReview: BoolFlag,
```

(Use the existing `BoolFlag` enum defined at line 28-32 — handles "true"/"false" strings correctly.)

- [ ] **Step 2: Apply filter in the GET handler IIFE at line 142-149**

The handler composes its `where` via an inline IIFE. Current code (line 142-149 of `apps/api/src/routes/transactions.ts`):

```ts
        ...(() => {
          if (q.uncategorizedOnly && q.categoryId) {
            return { allocations: { some: { OR: [{ categoryId: null }, { categoryId: q.categoryId }] } } };
          }
          if (q.uncategorizedOnly) return { allocations: { some: { categoryId: null } } };
          if (q.categoryId)        return { allocations: { some: { categoryId: q.categoryId } } };
          return {};
        })(),
```

Replace with (add the `needsReview` branch first — it's the most restrictive filter):

```ts
        ...(() => {
          if (q.needsReview) {
            return {
              allocations: {
                some: {
                  needsConfirmation: true,
                  categoryId: { not: null },
                  OR: [
                    { dismissedUntil: null },
                    { dismissedUntil: { lt: new Date() } },
                  ],
                },
              },
            };
          }
          if (q.uncategorizedOnly && q.categoryId) {
            return { allocations: { some: { OR: [{ categoryId: null }, { categoryId: q.categoryId }] } } };
          }
          if (q.uncategorizedOnly) return { allocations: { some: { categoryId: null } } };
          if (q.categoryId)        return { allocations: { some: { categoryId: q.categoryId } } };
          return {};
        })(),
```

`needsReview` is an alternative to (not combinable with) the other filters; precedence is fine because UI screens that use `needsReview` don't pass `categoryId`/`uncategorizedOnly` together.

- [ ] **Step 3: Tests**

```ts
// apps/api/tests/transactions.needs-review-query.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();
let app: Awaited<ReturnType<typeof buildApp>>;
let counter = 0;

beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup() {
  const u = await signUpAndGetCookie(app, { email: `nr-${counter++}@x.com`, name: "T" });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "A", type: "depository" } });
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "NRTestCat" } });
  return { cookie: u.cookie, wsId, accountId: acct.id, catId: cat.id };
}

async function makeTx(wsId: string, accountId: string, catId: string | null, opts: { needsConfirmation: boolean; dismissedUntil?: Date | null }) {
  return prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId,
      merchantRaw: "M", merchantNormalized: "m",
      amount: "5.00", occurredAt: new Date(),
      source: "plaid", rawData: {},
      allocations: { create: { amount: "5.00", categoryId: catId, source: catId ? "ai" : null, needsConfirmation: opts.needsConfirmation, dismissedUntil: opts.dismissedUntil ?? null } },
    },
  });
}

describe("GET /workspaces/:id/transactions?needsReview=true", () => {
  it("includes only allocations with needsConfirmation=true + categoryId + not snoozed", async () => {
    const { cookie, wsId, accountId, catId } = await setup();
    const a = await makeTx(wsId, accountId, catId, { needsConfirmation: true });
    await makeTx(wsId, accountId, catId, { needsConfirmation: false });
    await makeTx(wsId, accountId, null, { needsConfirmation: true });
    await makeTx(wsId, accountId, catId, { needsConfirmation: true, dismissedUntil: new Date(Date.now() + 60_000) });

    const r = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?needsReview=true`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.transactions.length).toBe(1);
    expect(body.transactions[0].id).toBe(a.id);
  });

  it("includes allocations whose dismissedUntil is in the past", async () => {
    const { cookie, wsId, accountId, catId } = await setup();
    await makeTx(wsId, accountId, catId, { needsConfirmation: true, dismissedUntil: new Date(Date.now() - 60_000) });
    const r = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions?needsReview=true`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = JSON.parse(r.body);
    expect(body.transactions.length).toBe(1);
  });

  it("?needsReview omitted → behaves like default (returns all)", async () => {
    const { cookie, wsId, accountId, catId } = await setup();
    await makeTx(wsId, accountId, catId, { needsConfirmation: true });
    await makeTx(wsId, accountId, catId, { needsConfirmation: false });
    const r = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const body = JSON.parse(r.body);
    expect(body.transactions.length).toBe(2);
  });
});
```

- [ ] **Step 4: Run + commit**

```bash
pnpm -F @fina/api exec vitest run tests/transactions.needs-review-query.test.ts
```

Expected: 3/3 PASS.

```bash
git add apps/api/src/routes/transactions.ts apps/api/tests/transactions.needs-review-query.test.ts
git commit -m "feat(api): GET /transactions ?needsReview=true filter"
```

---

## Task 7: Mobile — `ActionItemCard` component

**Files:**
- Create: `apps/mobile/src/home/ActionItemCard.tsx`

- [ ] **Step 1: Implement the reusable card**

```tsx
// apps/mobile/src/home/ActionItemCard.tsx
import { Pressable, Text, View, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, space, type as type$ } from "../design/tokens";

export type ActionItemCardProps = {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle?: string;
  onPress: () => void;
};

export function ActionItemCard({ icon, title, subtitle, onPress }: ActionItemCardProps) {
  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
      onPress={onPress}
    >
      <View style={styles.glyph}>
        <Ionicons name={icon} size={18} color={colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.sub}>{subtitle}</Text> : null}
      </View>
      <Ionicons name="chevron-forward" size={16} color={colors.mutedSoft} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
    marginBottom: space.sm,
    gap: space.sm,
  },
  glyph: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { ...type$.titleSm, color: colors.ink },
  sub: { ...type$.bodySm, color: colors.body, marginTop: 2 },
});
```

- [ ] **Step 2: Mobile typecheck**

```bash
pnpm typecheck
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/home/ActionItemCard.tsx
git commit -m "feat(mobile): reusable ActionItemCard for Home action items"
```

---

## Task 8: Mobile — `SpendCard` component

**Files:**
- Create: `apps/mobile/src/home/SpendCard.tsx`

- [ ] **Step 1: Implement**

```tsx
// apps/mobile/src/home/SpendCard.tsx
import { Pressable, Text, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { colors, space, type as type$ } from "../design/tokens";
import { formatMoney } from "../format/money";

export function SpendCard({
  currency,
  totalSpent,
  budgetCap,
}: {
  currency: string;
  /** Decimal string from /budget-plans/current totalSpent. */
  totalSpent: string;
  /** Decimal string sum of the plan's category caps, or null if no plan. */
  budgetCap: string | null;
}) {
  const spent = formatMoney(totalSpent, currency);
  const cap = budgetCap !== null ? formatMoney(budgetCap, currency) : null;
  const spentNum = Number(totalSpent);
  const capNum = budgetCap !== null ? Number(budgetCap) : 0;
  const pct = capNum > 0 ? Math.min(999, (spentNum / capNum) * 100) : 0;
  const over = pct > 100;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
      onPress={() => router.push("/budget" as never)}
    >
      <Text style={styles.amount}>{spent.display}</Text>
      <Text style={styles.label}>spent this month</Text>
      {cap ? (
        <>
          <View style={styles.barTrack}>
            <View
              style={[
                styles.barFill,
                { width: `${Math.min(100, pct)}%`, backgroundColor: over ? colors.down : colors.primary },
              ]}
            />
          </View>
          <Text style={[styles.barMeta, over && { color: colors.down }]}>
            of {cap.display} · {pct.toFixed(0)}%
          </Text>
        </>
      ) : (
        <Text style={styles.cta}>Set a budget →</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
    marginTop: space.base,
  },
  amount: { ...type$.titleLg, color: colors.ink },
  label: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceSoft,
    marginTop: space.sm,
    overflow: "hidden",
  },
  barFill: { height: 6, borderRadius: 3 },
  barMeta: { ...type$.bodySm, color: colors.body, marginTop: 4 },
  cta: { ...type$.captionStrong, color: colors.primary, marginTop: space.sm },
});
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/home/SpendCard.tsx
git commit -m "feat(mobile): SpendCard component for Home"
```

---

## Task 9: Mobile — Home redesign

**Files:**
- Modify: `apps/mobile/app/(tabs)/index.tsx`

The current Home has a hardcoded "Get started" checklist (4 cards). Replace with the Action Items + Spend card composition.

- [ ] **Step 1: Read current `apps/mobile/app/(tabs)/index.tsx`** to understand greeting/header structure, scroll handling, trial banner — keep all that.

- [ ] **Step 2: Add data-fetching hooks**

Inside the `Home` component, after the existing `me`/`bankCount`/`hasBudget` state, add:

```tsx
  const [plaidItems, setPlaidItems] = useState<PlaidItemDTO[] | null>(null);
  const [needsReviewCount, setNeedsReviewCount] = useState(0);
  const [pendingInvites, setPendingInvites] = useState(0);
  const [unreadFina, setUnreadFina] = useState(0);
  const [budgetCurrent, setBudgetCurrent] = useState<{ plan: unknown; totalSpent: string } | null>(null);
  const [hasGoal, setHasGoal] = useState<boolean | null>(null);
```

Add to imports:

```ts
import type { PlaidItemDTO } from "@fina/shared";
import { ActionItemCard } from "../../src/home/ActionItemCard";
import { SpendCard } from "../../src/home/SpendCard";
```

- [ ] **Step 3: Replace the existing single-effect fetcher with a `load()` callback + parallel Promise.all**

Wrap fetch logic in a `load` callback so the retry button (Step 5) can re-trigger it:

```tsx
  const load = useCallback(async () => {
    setErr(null);
    try {
      const wsId = await bootstrapActiveWorkspace();
      const meData = await apiFetch<Me>("/me");
      setMe(meData);
      if (!wsId) return;

      // Each result is independently swallowed so one failure doesn't
      // collapse the whole Home.
      await Promise.all([
        apiFetch<{ plaidItems: PlaidItemDTO[] }>(`/workspaces/${wsId}/plaid-items`)
          .then((r) => setPlaidItems(r.plaidItems))
          .catch(() => setPlaidItems([])),
        apiFetch<{ transactions: unknown[] }>(`/workspaces/${wsId}/transactions?needsReview=true&limit=50`)
          .then((r) => setNeedsReviewCount(r.transactions.length))
          .catch(() => setNeedsReviewCount(0)),
        apiFetch<{ invites: unknown[] }>("/me/incoming-invites")
          .then((r) => setPendingInvites(r.invites.length))
          .catch(() => setPendingInvites(0)),
        apiFetch<{ threads: Array<{ unreadCount: number }> }>("/chat/threads")
          .then((r) => setUnreadFina(r.threads.reduce((s, t) => s + (t.unreadCount ?? 0), 0)))
          .catch(() => setUnreadFina(0)),
        apiFetch<{ plan: { totalAmount?: number; categoryAllocations?: Array<{ amount: number }> } | null; totalSpent: string }>(`/workspaces/${wsId}/budget-plans/current`)
          .then((r) => setBudgetCurrent({ plan: r.plan, totalSpent: r.totalSpent }))
          .catch(() => setBudgetCurrent({ plan: null, totalSpent: "0.00" })),
        apiFetch<{ goals: unknown[] }>(`/workspaces/${wsId}/goals`)
          .then((r) => setHasGoal(r.goals.length > 0))
          .catch(() => setHasGoal(false)),
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);
```

Verified shapes:
- `/budget-plans/current` returns `{ plan, totalSpent }` where `plan` shape is `{ totalAmount: number, categoryAllocations?: [{ categoryId, amount }] }` or `null` (see `apps/api/src/routes/budget-plans.ts:105` + service.ts plan body).
- `/goals` returns `{ goals: GoalDTO[] }` — check `apps/api/src/routes/goals.ts` for the response shape if needed; `r.goals.length > 0` is the existence check.
- `/transactions?needsReview=true&limit=50` — display "50+" if length===50, otherwise show the actual length.

- [ ] **Step 4: Build the action items list**

After the state setup, derive cards:

```tsx
  const bankReconnects = (plaidItems ?? []).filter(
    (p) => p.status === "error" || p.errorCode === "ITEM_LOGIN_REQUIRED" || p.errorCode === "PENDING_EXPIRATION",
  );
  const days = me?.trial?.endsAt ? trialDaysLeft(me.trial.endsAt) : null;
  const trialUrgent = !!(me?.trial?.active && days !== null && days <= 5);

  const actionItems: Array<{ key: string; icon: keyof typeof Ionicons.glyphMap; title: string; subtitle?: string; href: string }> = [];

  // 1. Bank reconnect (highest priority — blocks sync)
  if (bankReconnects.length === 1) {
    actionItems.push({
      key: "bank",
      icon: "alert-circle-outline",
      title: `Reconnect ${bankReconnects[0]!.institutionName}`,
      href: "/banks",
    });
  } else if (bankReconnects.length > 1) {
    actionItems.push({
      key: "bank",
      icon: "alert-circle-outline",
      title: `Reconnect ${bankReconnects.length} banks`,
      href: "/banks",
    });
  }

  // 2. Unread Fina messages
  if (unreadFina > 0) {
    actionItems.push({
      key: "fina",
      icon: "chatbubble-outline",
      title: `Fina sent you ${unreadFina} message${unreadFina === 1 ? "" : "s"}`,
      href: "/(tabs)/chat",
    });
  }

  // 3. Categorize inbox
  if (needsReviewCount > 0) {
    const label = needsReviewCount >= 50 ? "50+" : `${needsReviewCount}`;
    actionItems.push({
      key: "categorize",
      icon: "construct-outline",
      title: `Confirm ${label} categorization${needsReviewCount === 1 ? "" : "s"}`,
      href: "/categorize/inbox",
    });
  }

  // 4. Trial expiring
  if (trialUrgent && days !== null) {
    actionItems.push({
      key: "trial",
      icon: "sparkles-outline",
      title: `Trial ends in ${days} day${days === 1 ? "" : "s"}`,
      href: "/subscriptions",
    });
  }

  // 5. Pending invites
  if (pendingInvites > 0) {
    actionItems.push({
      key: "invites",
      icon: "mail-outline",
      title: `${pendingInvites} workspace invite${pendingInvites === 1 ? "" : "s"}`,
      href: "/workspace/incoming",
    });
  }

  // 6. Onboarding (flat list of remaining steps)
  const hasBudget = budgetCurrent?.plan !== null;
  const bankCount = plaidItems?.length ?? 0;
  if (hasBudget === false) {
    actionItems.push({ key: "ob-budget", icon: "wallet-outline", title: "Set a monthly budget", subtitle: "Pick a total. Fina tracks every spend.", href: "/budget" });
  }
  if (bankCount === 0) {
    actionItems.push({ key: "ob-bank", icon: "card-outline", title: "Connect a bank", subtitle: "Plaid securely imports your transactions.", href: "/banks" });
  }
  if (hasGoal === false) {
    actionItems.push({ key: "ob-goal", icon: "flag-outline", title: "Set your first goal", subtitle: "Save for something. Pro feature, free during trial.", href: "/(tabs)/goals" });
  }
```

- [ ] **Step 5: Replace the existing `checklist.map` with the new render + add `/me` failure retry UI**

When `err` is set AND `me` is null, show retry button instead of collapsed page:

```tsx
        {!me && err && (
          <View style={styles.errCard}>
            <Text style={styles.errTitle}>Couldn't reach Fina</Text>
            <Text style={styles.errBody}>{err}</Text>
            <Pressable
              style={({ pressed }) => [styles.retryBtn, pressed && { opacity: 0.7 }]}
              onPress={() => load()}
            >
              <Text style={styles.retryBtnText}>Try again</Text>
            </Pressable>
          </View>
        )}

        {!me && !err && (
          <View style={{ paddingVertical: space.xxl }}>
            <ActivityIndicator color={colors.primary} />
          </View>
        )}

        {me && (
          <>
            {actionItems.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>Your queue</Text>
                {actionItems.map((it) => (
                  <ActionItemCard
                    key={it.key}
                    icon={it.icon}
                    title={it.title}
                    subtitle={it.subtitle}
                    onPress={() => router.push(it.href as never)}
                  />
                ))}
              </>
            )}

            {budgetCurrent && (
              <SpendCard
                currency="CAD"
                totalSpent={budgetCurrent.totalSpent}
                budgetCap={computeBudgetCap(budgetCurrent.plan)}
              />
            )}
          </>
        )}
```

Add the retry button styles to the existing `StyleSheet.create({ ... })`:

```ts
  retryBtn: {
    marginTop: space.sm,
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignSelf: "flex-start",
  },
  retryBtnText: { ...type$.bodySm, color: colors.onPrimary, fontWeight: "600" },
```

The `computeBudgetCap` helper extracts the plan's total cap. The plan shape (verified from `apps/api/src/routes/budget-plans.ts:28-29` schema and the `current` endpoint) is `{ totalAmount: number, categoryAllocations?: Array<{ categoryId: string, amount: number }> }` or `null`. Add as a local function in this file:

```ts
function computeBudgetCap(
  plan: { totalAmount?: number; categoryAllocations?: Array<{ amount: number }> } | null,
): string | null {
  if (!plan) return null;
  if (typeof plan.totalAmount === "number") return plan.totalAmount.toFixed(2);
  if (Array.isArray(plan.categoryAllocations)) {
    const sum = plan.categoryAllocations.reduce((s, c) => s + Number(c.amount ?? 0), 0);
    return sum > 0 ? sum.toFixed(2) : null;
  }
  return null;
}
```

- [ ] **Step 6: Typecheck + manual sanity**

```bash
pnpm typecheck
```

Mobile errors should be gone (apart from pre-existing zod auth/client one).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/app/(tabs)/index.tsx
git commit -m "feat(mobile): Home redesign — Action Items section + SpendCard"
```

---

## Task 10: Mobile — Categorize Inbox screen

**Files:**
- Create: `apps/mobile/app/categorize/inbox.tsx`

- [ ] **Step 1: Implement the screen**

```tsx
// apps/mobile/app/categorize/inbox.tsx
import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { MeDTO, TransactionDTO, CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { formatMoney } from "../../src/format/money";
import { CategoryPickerSheet } from "../../src/categories/CategoryPickerSheet";

type LoadResult = {
  txs: TransactionDTO[];
  categories: Record<string, CategoryDTO>;
  mode: "flexible" | "strict" | "auto";
  wsId: string;
};

export default function CategorizeInbox() {
  const [data, setData] = useState<LoadResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyTxId, setBusyTxId] = useState<string | null>(null);
  const [pickerTxId, setPickerTxId] = useState<string | null>(null);
  const [pickerSelectedId, setPickerSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const wsId = (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [me, list, cats] = await Promise.all([
        apiFetch<MeDTO>("/me"),
        apiFetch<{ transactions: TransactionDTO[] }>(`/workspaces/${wsId}/transactions?needsReview=true&limit=50`),
        apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${wsId}/categories`),
      ]);
      setData({
        txs: list.transactions,
        categories: Object.fromEntries(cats.categories.map((c) => [c.id, c])),
        mode: me.user.categorizationMode,
        wsId,
      });
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function confirmRow(tx: TransactionDTO) {
    if (!data) return;
    setBusyTxId(tx.id);
    setData({ ...data, txs: data.txs.filter((t) => t.id !== tx.id) });
    try {
      await apiFetch(`/workspaces/${data.wsId}/transactions/${tx.id}/confirm-category`, { method: "POST" });
    } catch (e) {
      Alert.alert("Couldn't confirm", (e as { code?: string }).code ?? "Try again.");
      load();
    } finally {
      setBusyTxId(null);
    }
  }

  function editRow(tx: TransactionDTO) {
    setPickerTxId(tx.id);
    setPickerSelectedId(tx.allocations[0]?.categoryId ?? null);
  }

  async function skipOrDismissRow(tx: TransactionDTO) {
    if (!data) return;
    setBusyTxId(tx.id);
    setData({ ...data, txs: data.txs.filter((t) => t.id !== tx.id) });
    if (data.mode === "auto") {
      try {
        await apiFetch(`/workspaces/${data.wsId}/transactions/${tx.id}/dismiss-category`, { method: "POST" });
      } catch (e) {
        Alert.alert("Couldn't dismiss", (e as { code?: string }).code ?? "Try again.");
        load();
      }
    }
    // Strict/Flexible: client-only dismiss; DB unchanged. Next refetch re-adds.
    setBusyTxId(null);
  }

  if (!data) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          {err ? <Text style={styles.errText}>Couldn't load ({err})</Text> : <ActivityIndicator color={colors.primary} />}
        </View>
      </SafeAreaView>
    );
  }

  const empty = data.txs.length === 0;
  const cancelLabel = data.mode === "auto" ? "Dismiss" : "Skip";
  const cancelHelper = data.mode === "auto" ? "Won't show again" : "Will show again next time";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header />
      <ScrollView contentContainerStyle={styles.scroll}>
        {empty ? (
          <View style={styles.emptyWrap}>
            <Ionicons name="checkmark-circle-outline" size={64} color={colors.primary} />
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptySub}>Nothing to review.</Text>
          </View>
        ) : (
          data.txs.map((tx) => {
            const alloc = tx.allocations[0]!;
            const cat = alloc.categoryId ? data.categories[alloc.categoryId] : null;
            const merchant = tx.merchantNormalized ?? tx.merchantRaw;
            const money = formatMoney(tx.amount, tx.currency);
            const isOther = (cat?.name ?? "").trim().toLowerCase() === "other";
            return (
              <View key={tx.id} style={styles.card}>
                <View style={styles.rowTop}>
                  <Text style={styles.merchant} numberOfLines={1}>{merchant}</Text>
                  <Text style={[styles.amount, money.isIncome && { color: colors.up }]}>
                    {money.isIncome ? "+" : "−"}{money.display}
                  </Text>
                </View>
                <View style={styles.rowMid}>
                  <Text style={styles.catLabel}>{cat?.name ?? "Uncategorized"}</Text>
                  {isOther && <View style={styles.otherChip}><Text style={styles.otherChipText}>Other</Text></View>}
                </View>
                <View style={styles.actions}>
                  <Pressable
                    style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && { opacity: 0.7 }]}
                    onPress={() => confirmRow(tx)}
                    disabled={busyTxId === tx.id}
                  >
                    <Text style={styles.btnPrimaryText}>Confirm</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.btn, styles.btnGhost, pressed && { opacity: 0.7 }]}
                    onPress={() => editRow(tx)}
                    disabled={busyTxId === tx.id}
                  >
                    <Text style={styles.btnGhostText}>Edit</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [styles.btn, styles.btnGhostMuted, pressed && { opacity: 0.7 }]}
                    onPress={() => skipOrDismissRow(tx)}
                    disabled={busyTxId === tx.id}
                  >
                    <Text style={styles.btnGhostMutedText}>{cancelLabel}</Text>
                  </Pressable>
                </View>
                <Text style={styles.helper}>{cancelHelper}</Text>
              </View>
            );
          })
        )}
      </ScrollView>

      <CategoryPickerSheet
        visible={pickerTxId !== null}
        txId={pickerTxId ?? ""}
        selectedId={pickerSelectedId}
        onClose={() => setPickerTxId(null)}
        onChange={() => {
          setPickerTxId(null);
          if (data && pickerTxId) {
            setData({ ...data, txs: data.txs.filter((t) => t.id !== pickerTxId) });
          }
        }}
      />
    </SafeAreaView>
  );
}

function Header() {
  return (
    <View style={styles.head}>
      <HeaderIconButton name="chevron-back" onPress={() => router.back()} />
      <Text style={styles.title}>Review queue</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.base, gap: space.sm, height: 56 },
  title: { ...type$.titleMd, color: colors.ink },
  scroll: { padding: space.lg, gap: space.sm },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  errText: { ...type$.bodyMd, color: colors.down },
  emptyWrap: { alignItems: "center", paddingVertical: space.xxl, gap: space.sm },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginTop: space.base },
  emptySub: { ...type$.bodySm, color: colors.muted },
  card: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 16,
    padding: space.base,
    marginBottom: space.sm,
    gap: 6,
  },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  merchant: { ...type$.titleSm, color: colors.ink, flex: 1, marginRight: space.sm },
  amount: { ...type$.titleSm, color: colors.ink },
  rowMid: { flexDirection: "row", alignItems: "center", gap: 6 },
  catLabel: { ...type$.bodySm, color: colors.body },
  otherChip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: "rgba(207, 32, 47, 0.10)" },
  otherChipText: { fontSize: 10, color: colors.down, fontWeight: "600" },
  actions: { flexDirection: "row", gap: 6, marginTop: space.sm },
  btn: { flex: 1, height: 40, alignItems: "center", justifyContent: "center", borderRadius: 10, minWidth: 0 },
  btnPrimary: { backgroundColor: colors.primary },
  btnPrimaryText: { ...type$.bodySm, color: colors.onPrimary, fontWeight: "600" },
  btnGhost: { borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.canvas },
  btnGhostText: { ...type$.bodySm, color: colors.ink, fontWeight: "600" },
  btnGhostMuted: { borderWidth: 1, borderColor: colors.hairline, backgroundColor: colors.canvas },
  btnGhostMutedText: { ...type$.bodySm, color: colors.muted, fontWeight: "600" },
  helper: { ...type$.bodySm, fontSize: 11, color: colors.muted, textAlign: "right" },
});
```

- [ ] **Step 2: Typecheck + manual smoke**

```bash
pnpm typecheck
```

No new mobile errors. Then start `pnpm smoke:mobile:lan` (per project memory, Tailscale 100.65.93.102 required for Expo Go) and navigate to `/categorize/inbox` to verify the screen renders.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/categorize/inbox.tsx
git commit -m "feat(mobile): Categorize Inbox screen with Confirm/Edit/Skip+Dismiss"
```

---

## Task 11: Mobile — More tab "Review queue" row

**Files:**
- Modify: `apps/mobile/app/(tabs)/more.tsx`

- [ ] **Step 1: Add a new row in the AI group**

Find the AI group (search for `<GroupLabel>AI</GroupLabel>` or the existing "Categorization style" row). Insert a new row after "Categorization style":

```tsx
          <SettingsRow
            icon="construct-outline"
            title="Review queue"
            detail={reviewQueueDetail(needsReviewCount)}
            onPress={() => router.push("/categorize/inbox" as never)}
            last
          />
```

Move `last` off the previous row (currently "Categorization style"). The Categorization style row no longer has `last`; Review queue does.

Add a state hook + helper:

```tsx
const [needsReviewCount, setNeedsReviewCount] = useState(0);

// inside an existing useFocusEffect or alongside the other loaders:
useEffect(() => {
  (async () => {
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) return;
      const r = await apiFetch<{ transactions: unknown[] }>(
        `/workspaces/${wsId}/transactions?needsReview=true&limit=50`,
      );
      setNeedsReviewCount(r.transactions.length);
    } catch {
      // Non-fatal — Review queue row falls back to no count.
    }
  })();
}, []);

function reviewQueueDetail(n: number): string {
  if (n === 0) return "0";
  if (n >= 50) return "50+";
  return String(n);
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/app/(tabs)/more.tsx
git commit -m "feat(mobile): More tab — Review queue row in AI group"
```

---

## Task 12: Mobile — Workspace incoming invites screen

**Files:**
- Create: `apps/mobile/app/workspace/incoming.tsx`

The backend already exposes `GET /me/incoming-invites` and `POST /me/incoming-invites/:id/accept`. Mobile just needs a screen.

- [ ] **Step 1: Implement**

```tsx
// apps/mobile/app/workspace/incoming.tsx
import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "../../src/api/client";
import { setActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";

type IncomingInvite = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  inviterEmail: string;
  inviterName: string | null;
  invitedRole: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
};

export default function IncomingInvites() {
  const [invites, setInvites] = useState<IncomingInvite[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ invites: IncomingInvite[] }>("/me/incoming-invites");
      setInvites(r.invites);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function accept(inv: IncomingInvite) {
    setBusyId(inv.id);
    try {
      await apiFetch(`/me/incoming-invites/${inv.id}/accept`, { method: "POST" });
      await setActiveWorkspaceId(inv.workspaceId);
      // Re-bootstrap: go to Home for the new workspace.
      router.replace("/(tabs)" as never);
    } catch (e) {
      Alert.alert("Couldn't accept", (e as { code?: string }).code ?? "Try again.");
      setBusyId(null);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton name="chevron-back" onPress={() => router.back()} />
        <Text style={styles.title}>Invitations</Text>
      </View>
      <ScrollView contentContainerStyle={styles.scroll}>
        {invites === null && !err && <ActivityIndicator color={colors.primary} />}
        {err && <Text style={styles.errText}>Couldn't load ({err})</Text>}
        {invites !== null && invites.length === 0 && (
          <View style={styles.emptyWrap}>
            <Ionicons name="mail-outline" size={48} color={colors.muted} />
            <Text style={styles.emptyTitle}>No pending invitations</Text>
          </View>
        )}
        {invites !== null && invites.map((inv) => (
          <View key={inv.id} style={styles.card}>
            <Text style={styles.wsName}>{inv.workspaceName}</Text>
            <Text style={styles.meta}>
              {inv.inviterName ?? inv.inviterEmail} invited you as {inv.invitedRole}
            </Text>
            <Pressable
              style={({ pressed }) => [styles.btnPrimary, pressed && { opacity: 0.7 }]}
              onPress={() => accept(inv)}
              disabled={busyId === inv.id}
            >
              <Text style={styles.btnPrimaryText}>{busyId === inv.id ? "Joining..." : "Accept"}</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.base, gap: space.sm, height: 56 },
  title: { ...type$.titleMd, color: colors.ink },
  scroll: { padding: space.lg, gap: space.sm },
  errText: { ...type$.bodyMd, color: colors.down, textAlign: "center", marginTop: space.xxl },
  emptyWrap: { alignItems: "center", paddingVertical: space.xxl, gap: space.sm },
  emptyTitle: { ...type$.titleSm, color: colors.muted },
  card: { backgroundColor: colors.surfaceSoft, borderRadius: 16, padding: space.base, marginBottom: space.sm, gap: space.xs },
  wsName: { ...type$.titleSm, color: colors.ink },
  meta: { ...type$.bodySm, color: colors.body },
  btnPrimary: { backgroundColor: colors.primary, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center", marginTop: space.sm },
  btnPrimaryText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },
});
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
```

```bash
git add apps/mobile/app/workspace/incoming.tsx
git commit -m "feat(mobile): /workspace/incoming pending invites screen"
```

---

## Task 13: Mobile — mark chat thread as read on view

**Files:**
- Modify: `apps/mobile/app/(tabs)/chat.tsx` (verified location — uses `useLocalSearchParams<{ thread?: string }>()` at line 17)

- [ ] **Step 1: Add mark-read effect**

In `apps/mobile/app/(tabs)/chat.tsx`, find the existing `useLocalSearchParams<{ thread?: string }>()` block. The `params.thread` is the active thread id. Add an effect that fires when a thread becomes selected:

```tsx
import { useEffect } from "react"; // confirm already imported; if not, add to existing imports
// ...inside the component, after params is destructured...
useEffect(() => {
  if (!params.thread) return;
  apiFetch(`/chat/threads/${params.thread}/read`, { method: "POST" }).catch(() => {
    // swallow — read mark is best-effort
  });
}, [params.thread]);
```

Confirm `apiFetch` is already imported in this file (likely yes via existing chat API calls). If not, add: `import { apiFetch } from "../../src/api/client";`.

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm typecheck
```

```bash
git add apps/mobile/app/\(tabs\)/chat.tsx
git commit -m "feat(mobile): mark chat thread as read on view"
```

---

## Self-review

**Spec coverage:**
- §1 Categorize Inbox screen → Task 10 + supporting backend Tasks 5, 6
- §2 Home redesign with Action Items + SpendCard → Tasks 7, 8, 9
- §3 Shared lib (ChatThreadDTO extension, transactions query param) → Tasks 1, 6
- §4 Migration (ChatThread.lastReadAt) → Task 2
- §5 UX details (3-button row, mode-dependent labels, optimistic updates) → Task 10
- Additional mobile screen `/workspace/incoming` → Task 12
- Read-mark policy (explicit POST on thread open) → Tasks 3 + 13
- Unread N+1 mitigation (single GROUP BY query) → Task 4

**Placeholder scan:** No "TBD"/"implement later" left. The `computeBudgetCap` helper notes it should be verified against the actual plan shape; this is a concrete TODO with steps (Read budget-plans route) rather than a placeholder. Goal endpoint shape `r.goals` is also flagged for verification.

**Type consistency:**
- `CategorizationMode` ('flexible' | 'strict' | 'auto') matches the existing shared lib export.
- `PlaidItemDTO.status` and `errorCode` match the shared DTO.
- `ChatThreadDTO.unreadCount` is `number` everywhere.
- `BoolFlag` zod pattern is used (not `z.coerce.boolean()`).

**Test paths:** All under `apps/api/tests/<name>.test.ts` (repo convention). Module-scope `app` + counter-based emails (canonical pattern).
