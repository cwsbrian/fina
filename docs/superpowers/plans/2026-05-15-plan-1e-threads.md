# Plan 1E-threads Implementation Plan: Multi-Thread Chat + Wider Context Window

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the one-thread-per-workspace constraint on Fina's chat, replace the implicit upsert API with explicit ChatGPT-style endpoints, and widen the per-turn history sent to Gemini (count cap 200 + token budget 400k).

**Architecture:** Schema migration drops `@@unique([workspaceId, type])` and the `type` enum, adds nullable `title`, `lastMessageAt`, `archivedAt`. A new `apps/api/src/chat/threads.ts` service module owns the thread CRUD primitives. `apps/api/src/routes/chat.ts` is rewritten to host six routes (`POST threads`, `POST messages`, `GET list`, `GET one`, `PATCH`, `DELETE`). `apps/api/src/chat/turn.ts` swaps its history loader for a hybrid count + token-budget walk, using a new `apps/api/src/chat/token-estimate.ts` heuristic. No tool or registry changes.

**Tech Stack:** TypeScript ESM, Zod, Prisma (PostgreSQL on port 5433), Fastify, Vitest, `@google/genai`.

**Spec:** `docs/superpowers/specs/2026-05-15-plan-1e-threads-design.md`

---

## File Structure

**Created:**
- `apps/api/prisma/migrations/<timestamp>_multi_thread_chat/migration.sql` — drop index/column/enum, add nullable columns, backfill `lastMessageAt`, add new index.
- `apps/api/src/chat/threads.ts` — thread CRUD service (create, list, findOwned, patch, archive).
- `apps/api/src/chat/token-estimate.ts` — rough chars/4 heuristic.
- `apps/api/tests/chat.threads.test.ts` — service unit tests.
- `apps/api/tests/chat.token-estimate.test.ts` — heuristic tests.
- `e2e/plan-1e-threads.spec.ts` — Playwright spec, two threads in one workspace, archive flow.

**Modified:**
- `apps/api/prisma/schema.prisma` — `ChatThread` updates, drop `ChatThreadType` enum.
- `apps/api/src/env.ts` — replace `CHAT_HISTORY_LIMIT` with two new optional keys.
- `apps/api/src/routes/chat.ts` — rewritten to host the six new routes; old `POST /chat/message` and `GET /chat/thread` removed.
- `apps/api/src/chat/turn.ts` — history selection replaced with count+token walk; lifts `MAX_TOOL_CALLS` defaults unchanged.
- `apps/api/tests/chat.routes.test.ts` — rewritten to cover the new routes and the auth matrix.
- `apps/api/tests/chat.turn.test.ts` — drop `type: "adhoc"` seed call; add cases for the two caps.

**Untouched:**
- All 11 chat tool files and their tests under `apps/api/src/chat/tools/` and `apps/api/tests/chat.tools.*.test.ts`.
- `apps/api/src/chat/dispatcher.ts`, `apps/api/src/chat/gemini-adapter.ts`, `apps/api/src/chat/context.ts`.

---

## Shared Conventions (apply to every task)

1. **Imports.** Project compiles to ESM. All relative imports end in `.js` (`"../../db.js"`, `"./threads.js"`).
2. **Prisma access.** `prisma` from `"../db.js"`. No service layer in this plan; `threads.ts` calls Prisma directly.
3. **Workspace isolation.** Every thread/message query MUST include `workspaceId: ctx.membership.workspaceId`. Cross-workspace lookups by id MUST return `null`, surfaced as 404 `thread_not_found` at the route.
4. **Auth helper.** Every route calls `requireWorkspaceContext(req, app, { requiredRole })` first, then `if (ctx.membership.workspaceId !== params.id) return reply.code(400).send({ error: "workspace_mismatch" })`. Existing 1E-chat pattern in `apps/api/src/routes/chat.ts`. `HttpError` thrown by the helper is caught at the bottom with `if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code }); throw e;`.
5. **Tier check.** On mutating routes only: `const tier = await effectiveTier(ctx.session.userId); if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });`. GET routes skip the tier check.
6. **Test framework.** Vitest. Tests live in `apps/api/tests/`. `prisma` imported from `"../src/db.js"`. Helpers used:
   - `signUpAndGetCookie(app, email)` — create a user + signed-in cookie. Defined in `tests/helpers/auth.ts`.
   - `getOwnerWorkspaceId(app, cookie)` — fetch the user's workspace id.
   - `makePro(userId)` — local helper in `chat.routes.test.ts` that sets `trialEndsAt` to a future date so `effectiveTier` returns Pro.
   - `truncateAll()` and `disconnect()` from `tests/helpers/db.ts`.
   - `chatGeminiMock(...)` and `resetGeminiMock()` from `tests/helpers/gemini-mock.ts` for Gemini stubbing.
7. **Commands.**
   - Single test file: `pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/<file>.test.ts`
   - Full api suite: `pnpm --filter @fina/api test`
   - Typecheck: `pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json`
   - Apply migrations to dev + test DB: `DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api db:deploy` then same with `/fina_test`.
8. **Migration file name.** Use a fresh timestamp prefix; the engineer can use `pnpm --filter @fina/api exec prisma migrate dev --create-only --name multi_thread_chat` to scaffold, or hand-create the directory under `apps/api/prisma/migrations/`.
9. **Error codes** are short snake_case strings: `thread_not_found`, `workspace_mismatch`, `upgrade_required`, `chat_provider_error`, `invalid_body`. Match the existing pattern.

---

## Task 1: Schema migration + reset chat module

**Goal:** Drop the old uniqueness constraint and enum, add the new columns, and reset `chat.ts` to a no-op so subsequent tasks can add one route at a time without the old routes breaking compilation.

**Files:**
- Create: `apps/api/prisma/migrations/<ts>_multi_thread_chat/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/routes/chat.ts` (full reset)
- Modify: `apps/api/tests/chat.routes.test.ts` (reset to a placeholder)
- Modify: `apps/api/tests/chat.turn.test.ts` (drop `type: "adhoc"` seed)

### Step 1.1: Update `schema.prisma`

In `apps/api/prisma/schema.prisma`, replace the `ChatThread` model and remove the `ChatThreadType` enum.

Replace:
```prisma
model ChatThread {
  id          String         @id @default(cuid())
  workspaceId String
  type        ChatThreadType @default(adhoc)
  createdAt   DateTime       @default(now())
  updatedAt   DateTime       @updatedAt

  workspace Workspace     @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  messages  ChatMessage[]

  @@unique([workspaceId, type])
  @@map("chat_threads")
}

enum ChatThreadType {
  adhoc
  daily
}
```

With:
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

  // NOTE: list-by-recency index is created by the migration SQL with
  // `lastMessageAt DESC NULLS LAST`. Prisma's @@index syntax cannot express
  // NULLS LAST, so omitting the directive here avoids schema drift. The
  // engineer should resist adding it back in `prisma migrate dev` outputs.
  @@map("chat_threads")
}
```

The `ChatThreadType` enum definition is removed entirely. `ChatMessage` and `ChatMessageRole` are unchanged.

### Step 1.2: Create the migration

Create the directory `apps/api/prisma/migrations/<timestamp>_multi_thread_chat/` (use a current timestamp like `20260516000000`). Add `migration.sql`:

```sql
-- DropIndex (Prisma's @@unique creates a unique INDEX, not a CONSTRAINT — DROP CONSTRAINT would fail)
DROP INDEX "chat_threads_workspaceId_type_key";

-- DropColumn + DropEnum
ALTER TABLE "chat_threads" DROP COLUMN "type";
DROP TYPE "ChatThreadType";

-- AddColumn
ALTER TABLE "chat_threads" ADD COLUMN "title" TEXT;
ALTER TABLE "chat_threads" ADD COLUMN "lastMessageAt" TIMESTAMP(3);
ALTER TABLE "chat_threads" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Backfill lastMessageAt from the most recent message per thread (NULL when the thread has no messages yet)
UPDATE "chat_threads" ct
SET "lastMessageAt" = (
  SELECT MAX("createdAt") FROM "chat_messages" WHERE "threadId" = ct.id
);

-- CreateIndex (compound key for list-by-recency, excluding archived).
-- NULLS LAST matches the list-route query (`lastMessageAt DESC NULLS LAST`);
-- the default for `DESC` would be NULLS FIRST and the planner would skip the index.
CREATE INDEX "chat_threads_workspaceId_archivedAt_lastMessageAt_idx"
  ON "chat_threads"("workspaceId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
```

### Step 1.3: Reset `routes/chat.ts`

Replace the entire file contents with the empty plugin shell:

```typescript
import type { FastifyInstance } from "fastify";

export async function chatRoutes(_app: FastifyInstance): Promise<void> {
  // Routes will be added by subsequent tasks.
}
```

This lets the api still build while we add routes one at a time. The old `POST /chat/message` and `GET /chat/thread` are deleted.

### Step 1.4: Reset `tests/chat.routes.test.ts`

Replace the entire file contents with a placeholder that compiles and runs:

```typescript
import { describe, it } from "vitest";

describe("chatRoutes (placeholder — routes added by Tasks 4-10)", () => {
  it.skip("placeholder", () => {});
});
```

This avoids leaving stale assertions referencing the old route shape.

### Step 1.5: Drop `type: "adhoc"` from `tests/chat.turn.test.ts`

In `apps/api/tests/chat.turn.test.ts`, line 25 currently reads:

```typescript
const thread = await prisma.chatThread.create({ data: { workspaceId: wsId, type: "adhoc" } });
```

Change it to:

```typescript
const thread = await prisma.chatThread.create({ data: { workspaceId: wsId } });
```

No other lines change in this task; the turn-test scenarios still pass against the old 20-message cap. The cap moves in Task 9.

### Step 1.6: Apply migrations + regenerate Prisma client

- [ ] **Step 1.6.a: Apply to dev DB**

Run:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api db:deploy
```
Expected: `<timestamp>_multi_thread_chat` applied, `Database migrations have been successfully applied`.

- [ ] **Step 1.6.b: Apply to test DB**

Run:
```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy
```
Expected: same migration applied.

- [ ] **Step 1.6.c: Regenerate Prisma client**

Run:
```bash
pnpm --filter @fina/api exec prisma generate
```
Expected: `Generated Prisma Client … in <ms>`.

### Step 1.7: Run the full api suite + typecheck

Run:
```bash
pnpm --filter @fina/api test
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json
```
Expected: every test still green except the chat.routes placeholder is skipped; typecheck has only the pre-existing two errors in `apps/api/src/chat/turn.ts` (lines 60 and 112, from Plan 1E-chat — out of scope).

### Step 1.8: Commit

```bash
git add apps/api/prisma/schema.prisma \
        apps/api/prisma/migrations/<ts>_multi_thread_chat/migration.sql \
        apps/api/src/routes/chat.ts \
        apps/api/tests/chat.routes.test.ts \
        apps/api/tests/chat.turn.test.ts
git commit -m "feat(plan 1e-threads): migration + reset chat routes module"
```

---

## Task 2: Token-estimate helper

**Files:**
- Create: `apps/api/src/chat/token-estimate.ts`
- Create: `apps/api/tests/chat.token-estimate.test.ts`

### Step 2.1: Write the failing test

Create `apps/api/tests/chat.token-estimate.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { estimateMessageTokens } from "../src/chat/token-estimate.js";

describe("estimateMessageTokens", () => {
  it("baseline for empty array: ceil('[]'.length / 4) = 1", () => {
    expect(estimateMessageTokens([])).toBe(1);
  });

  it("scales with payload size (~chars/4)", () => {
    const small = estimateMessageTokens([{ type: "text", markdown: "hi" }]);
    const big = estimateMessageTokens([{ type: "text", markdown: "x".repeat(4000) }]);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeGreaterThanOrEqual(1000); // 4000 markdown chars ≈ 1000 tokens lower bound
    expect(big).toBeLessThan(1050); // small JSON overhead only
  });

  it("is stable for the same input", () => {
    const blocks = [{ type: "tool", toolName: "listAccounts", args: {}, result: { output: { accounts: [] } } }];
    expect(estimateMessageTokens(blocks)).toBe(estimateMessageTokens(blocks));
  });

  it("uses JSON serialization (object keys count toward size)", () => {
    const a = estimateMessageTokens({ a: 1 });
    const b = estimateMessageTokens({ aaaaaaaaaa: 1 });
    expect(b).toBeGreaterThan(a);
  });
});
```

### Step 2.2: Run the test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.token-estimate.test.ts
```
Expected: FAIL with `Cannot find module '../src/chat/token-estimate.js'`.

### Step 2.3: Implement the helper

Create `apps/api/src/chat/token-estimate.ts`:

```typescript
// Rough heuristic: 4 chars ≈ 1 token. Safety valve against pathological
// tool-result payloads. NOT for billing or precise budgeting.
export function estimateMessageTokens(blocks: unknown): number {
  return Math.ceil(JSON.stringify(blocks).length / 4);
}
```

### Step 2.4: Run the test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.token-estimate.test.ts
```
Expected: 4/4 PASS.

### Step 2.5: Commit

```bash
git add apps/api/src/chat/token-estimate.ts apps/api/tests/chat.token-estimate.test.ts
git commit -m "feat(plan 1e-threads): token-estimate helper"
```

---

## Task 3: Threads service module

**Goal:** Centralize the thread CRUD primitives so routes stay thin and the service is unit-testable.

**Files:**
- Create: `apps/api/src/chat/threads.ts`
- Create: `apps/api/tests/chat.threads.test.ts`

### Step 3.1: Write the failing test

Create `apps/api/tests/chat.threads.test.ts`:

```typescript
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { threadsService } from "../src/chat/threads.js";

describe("threadsService", () => {
  let wsId: string;
  let otherWsId: string;

  beforeEach(async () => {
    await truncateAll();
    const u = await prisma.user.create({ data: { id: `th-${Date.now()}`, email: `th-${Date.now()}@t.co`, name: "TH" } });
    const ws = await prisma.workspace.create({ data: { name: "th-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    const ws2 = await prisma.workspace.create({ data: { name: "other-ws" } });
    otherWsId = ws2.id;
  });

  afterAll(async () => { await disconnect(); });

  it("create returns a row scoped to the workspace", async () => {
    const t = await threadsService.create({ workspaceId: wsId, title: null });
    expect(t.workspaceId).toBe(wsId);
    expect(t.title).toBeNull();
    expect(t.archivedAt).toBeNull();
    expect(t.lastMessageAt).toBeNull();
  });

  it("list returns non-archived threads sorted by lastMessageAt desc, then createdAt desc", async () => {
    const a = await threadsService.create({ workspaceId: wsId, title: "a" });
    const b = await threadsService.create({ workspaceId: wsId, title: "b" });
    // bump b's lastMessageAt
    await prisma.chatThread.update({ where: { id: b.id }, data: { lastMessageAt: new Date("2026-05-15T10:00:00Z") } });
    const list = await threadsService.list({ workspaceId: wsId, includeArchived: false, limit: 50 });
    expect(list.map((t) => t.id)).toEqual([b.id, a.id]);
  });

  it("list excludes archived by default", async () => {
    const a = await threadsService.create({ workspaceId: wsId });
    const b = await threadsService.create({ workspaceId: wsId });
    await prisma.chatThread.update({ where: { id: a.id }, data: { archivedAt: new Date() } });
    const visible = await threadsService.list({ workspaceId: wsId, includeArchived: false, limit: 50 });
    expect(visible.map((t) => t.id)).toEqual([b.id]);
    const all = await threadsService.list({ workspaceId: wsId, includeArchived: true, limit: 50 });
    expect(all.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("findOwned returns the thread when workspace matches", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const found = await threadsService.findOwned({ threadId: t.id, workspaceId: wsId });
    expect(found?.id).toBe(t.id);
  });

  it("findOwned returns null for cross-workspace lookups", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const found = await threadsService.findOwned({ threadId: t.id, workspaceId: otherWsId });
    expect(found).toBeNull();
  });

  it("patch updates title; null clears it", async () => {
    const t = await threadsService.create({ workspaceId: wsId, title: "first" });
    const renamed = await threadsService.patch({ threadId: t.id, workspaceId: wsId, title: "second" });
    expect(renamed?.title).toBe("second");
    const cleared = await threadsService.patch({ threadId: t.id, workspaceId: wsId, title: null });
    expect(cleared?.title).toBeNull();
  });

  it("patch returns null for cross-workspace ids", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const result = await threadsService.patch({ threadId: t.id, workspaceId: otherWsId, title: "evil" });
    expect(result).toBeNull();
  });

  it("archive sets archivedAt; second call is a no-op (still archived)", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const first = await threadsService.archive({ threadId: t.id, workspaceId: wsId });
    expect(first?.archivedAt).toBeInstanceOf(Date);
    const second = await threadsService.archive({ threadId: t.id, workspaceId: wsId });
    expect(second?.archivedAt).toBeInstanceOf(Date);
    // archivedAt should not change between calls
    expect(second?.archivedAt?.getTime()).toBe(first?.archivedAt?.getTime());
  });

  it("archive returns null for cross-workspace ids", async () => {
    const t = await threadsService.create({ workspaceId: wsId });
    const result = await threadsService.archive({ threadId: t.id, workspaceId: otherWsId });
    expect(result).toBeNull();
  });
});
```

### Step 3.2: Run the test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.threads.test.ts
```
Expected: FAIL with `Cannot find module '../src/chat/threads.js'`.

### Step 3.3: Implement the service

Create `apps/api/src/chat/threads.ts`:

```typescript
import type { ChatThread } from "@prisma/client";
import { prisma } from "../db.js";

export const threadsService = {
  async create(input: { workspaceId: string; title?: string | null }): Promise<ChatThread> {
    return prisma.chatThread.create({
      data: { workspaceId: input.workspaceId, title: input.title ?? null },
    });
  },

  async list(input: { workspaceId: string; includeArchived: boolean; limit: number }): Promise<ChatThread[]> {
    return prisma.chatThread.findMany({
      where: {
        workspaceId: input.workspaceId,
        ...(input.includeArchived ? {} : { archivedAt: null }),
      },
      // Postgres' default for `DESC` is NULLS FIRST. We want empty threads (lastMessageAt is null)
      // sorted last so active conversations show up first.
      orderBy: [
        { lastMessageAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: input.limit,
    });
  },

  async findOwned(input: { threadId: string; workspaceId: string }): Promise<ChatThread | null> {
    return prisma.chatThread.findFirst({
      where: { id: input.threadId, workspaceId: input.workspaceId },
    });
  },

  async patch(input: { threadId: string; workspaceId: string; title: string | null }): Promise<ChatThread | null> {
    const existing = await prisma.chatThread.findFirst({
      where: { id: input.threadId, workspaceId: input.workspaceId },
      select: { id: true },
    });
    if (!existing) return null;
    return prisma.chatThread.update({
      where: { id: existing.id },
      data: { title: input.title },
    });
  },

  async archive(input: { threadId: string; workspaceId: string }): Promise<ChatThread | null> {
    const existing = await prisma.chatThread.findFirst({
      where: { id: input.threadId, workspaceId: input.workspaceId },
      select: { id: true, archivedAt: true },
    });
    if (!existing) return null;
    if (existing.archivedAt) {
      // Already archived — return current row unchanged.
      return prisma.chatThread.findFirstOrThrow({ where: { id: existing.id } });
    }
    return prisma.chatThread.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });
  },
};
```

### Step 3.4: Run the test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.threads.test.ts
```
Expected: all 9 tests PASS.

### Step 3.5: Commit

```bash
git add apps/api/src/chat/threads.ts apps/api/tests/chat.threads.test.ts
git commit -m "feat(plan 1e-threads): threads service (create/list/findOwned/patch/archive)"
```

---

## Task 4: `POST /chat/threads` route

**Goal:** Add the first route — create an empty thread. Establishes the route file structure: auth → tier → service → response.

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/tests/chat.routes.test.ts`

### Step 4.1: Write the failing test

Replace the contents of `apps/api/tests/chat.routes.test.ts` with the following starting skeleton + test for this task (subsequent tasks append):

```typescript
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { resetGeminiMock } from "./helpers/gemini-mock.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });

beforeEach(async () => {
  await truncateAll();
  resetGeminiMock();
});

async function makePro(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), trialConsumed: false },
  });
}

async function setupProUser(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  await makePro(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

describe("POST /workspaces/:wsId/chat/threads", () => {
  it("creates an empty thread for a Pro editor", async () => {
    const { cookie, wsId } = await setupProUser(`p-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "First chat" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.thread.title).toBe("First chat");
    expect(body.thread.archivedAt).toBeNull();
    expect(body.thread.lastMessageAt).toBeNull();
    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: body.thread.id } });
    expect(row.workspaceId).toBe(wsId);
  });

  it("title is optional", async () => {
    const { cookie, wsId } = await setupProUser(`p-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().thread.title).toBeNull();
  });

  it("rejects viewer-role members with 403", async () => {
    const { cookie, wsId, userId } = await setupProUser(`p-${Date.now()}@t.co`);
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });

  it("rejects free-tier with 402", async () => {
    const { cookie, wsId, userId } = await setupProUser(`p-${Date.now()}@t.co`);
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000), trialConsumed: true } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: {},
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("upgrade_required");
  });

  it("rejects title longer than 200 chars with 400", async () => {
    const { cookie, wsId } = await setupProUser(`p-${Date.now()}@t.co`);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });
});
```

### Step 4.2: Run the test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 5/5 tests FAIL with `Route POST:/workspaces/.../chat/threads not found` or 404 (since the route isn't added yet).

### Step 4.3: Implement the route

Replace `apps/api/src/routes/chat.ts` with:

```typescript
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import { threadsService } from "../chat/threads.js";

const CreateBody = z.object({
  title: z.string().min(1).max(200).optional(),
});

function serializeThread(t: { id: string; title: string | null; lastMessageAt: Date | null; archivedAt: Date | null; createdAt: Date }) {
  return {
    id: t.id,
    title: t.title,
    lastMessageAt: t.lastMessageAt?.toISOString() ?? null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/chat/threads", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") {
        return reply.code(402).send({ error: "upgrade_required" });
      }
      const thread = await threadsService.create({
        workspaceId: ctx.membership.workspaceId,
        title: parsed.data.title ?? null,
      });
      return reply.code(201).send({ thread: serializeThread(thread) });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
```

### Step 4.4: Run the test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 5/5 PASS.

### Step 4.5: Commit

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
git commit -m "feat(plan 1e-threads): POST /chat/threads (create empty)"
```

---

## Task 5: `GET /chat/threads` (list)

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/tests/chat.routes.test.ts`

### Step 5.1: Append the failing test

Append the following `describe` block to `apps/api/tests/chat.routes.test.ts` (after the Task 4 block):

```typescript
describe("GET /workspaces/:wsId/chat/threads", () => {
  it("returns non-archived threads sorted by lastMessageAt desc, with messageCount and firstMessagePreview", async () => {
    const { cookie, wsId } = await setupProUser(`l-${Date.now()}@t.co`);
    const t1 = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "older" } });
    const t2 = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "newer" } });
    await prisma.chatThread.update({ where: { id: t1.id }, data: { lastMessageAt: new Date("2026-05-10T00:00:00Z") } });
    await prisma.chatThread.update({ where: { id: t2.id }, data: { lastMessageAt: new Date("2026-05-15T00:00:00Z") } });
    await prisma.chatMessage.create({ data: { threadId: t1.id, role: "user", blocks: [{ type: "text", markdown: "Hello world" }] } });

    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/chat/threads`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.threads.map((t: { id: string }) => t.id)).toEqual([t2.id, t1.id]);
    const older = body.threads.find((t: { id: string }) => t.id === t1.id);
    expect(older.title).toBe("older");
    expect(older.messageCount).toBe(1);
    expect(older.firstMessagePreview).toBe("Hello world");
  });

  it("excludes archived threads by default; include_archived=true returns them", async () => {
    const { cookie, wsId } = await setupProUser(`l-${Date.now()}@t.co`);
    const archived = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "old", archivedAt: new Date() } });
    const active = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "live" } });

    const def = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads`, headers: { cookie, "x-workspace-id": wsId } });
    expect(def.json().threads.map((t: { id: string }) => t.id)).toEqual([active.id]);

    const full = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads?include_archived=true`, headers: { cookie, "x-workspace-id": wsId } });
    expect(full.json().threads.map((t: { id: string }) => t.id).sort()).toEqual([active.id, archived.id].sort());
  });

  it("respects limit (default 50, max 100)", async () => {
    const { cookie, wsId } = await setupProUser(`l-${Date.now()}@t.co`);
    for (let i = 0; i < 3; i++) await prisma.chatThread.create({ data: { workspaceId: wsId } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads?limit=2`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.json().threads).toHaveLength(2);

    const over = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads?limit=101`, headers: { cookie, "x-workspace-id": wsId } });
    expect(over.statusCode).toBe(400);
    expect(over.json().error).toBe("invalid_query");
  });

  it("succeeds for viewer + free-tier (GET is not tier-gated)", async () => {
    const { cookie, wsId, userId } = await setupProUser(`l-${Date.now()}@t.co`);
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
  });

  it("isolates by workspace", async () => {
    const a = await setupProUser(`l-${Date.now()}-a@t.co`);
    const b = await setupProUser(`l-${Date.now()}-b@t.co`);
    await prisma.chatThread.create({ data: { workspaceId: b.wsId, title: "B's thread" } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${a.wsId}/chat/threads`, headers: { cookie: a.cookie, "x-workspace-id": a.wsId } });
    expect(res.json().threads).toHaveLength(0);
  });
});
```

### Step 5.2: Run the test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: the 5 new tests FAIL with 404; Task 4's 5 tests still PASS.

### Step 5.3: Add the list route

In `apps/api/src/routes/chat.ts`, add the following Zod query parser at the top (under the `CreateBody` declaration) and append the route handler at the bottom of `chatRoutes` (just before the closing brace):

Add query parser (after `CreateBody`):
```typescript
const ListQuery = z.object({
  include_archived: z.union([z.literal("true"), z.literal("false")]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
```

Append route inside `chatRoutes`:
```typescript
  app.get("/workspaces/:id/chat/threads", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = ListQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });

    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }

      const includeArchived = parsed.data.include_archived === "true";
      const limit = parsed.data.limit ?? 50;
      const threads = await threadsService.list({
        workspaceId: ctx.membership.workspaceId,
        includeArchived,
        limit,
      });

      // Hydrate per-thread aggregates: messageCount + firstMessagePreview.
      const threadIds = threads.map((t) => t.id);
      const counts = threadIds.length === 0 ? [] : await prisma.chatMessage.groupBy({
        by: ["threadId"],
        where: { threadId: { in: threadIds } },
        _count: { _all: true },
      });
      // Prisma `distinct` keeps the first row per `threadId` in the supplied orderBy.
      // Ordering by threadId then createdAt asc → one row per thread, oldest first.
      const firstUserMessages = threadIds.length === 0 ? [] : await prisma.chatMessage.findMany({
        where: { threadId: { in: threadIds }, role: "user" },
        orderBy: [{ threadId: "asc" }, { createdAt: "asc" }],
        distinct: ["threadId"],
        select: { threadId: true, blocks: true },
      });
      const countByThread = new Map(counts.map((c) => [c.threadId, c._count._all]));
      const previewByThread = new Map<string, string | null>();
      for (const row of firstUserMessages) {
        const blocks = Array.isArray(row.blocks) ? row.blocks : [];
        const textBlock = (blocks as Array<{ type?: unknown; markdown?: unknown }>).find(
          (b) => b?.type === "text" && typeof b?.markdown === "string",
        );
        const md = textBlock?.markdown as string | undefined;
        previewByThread.set(row.threadId, md ? md.slice(0, 100) : null);
      }

      return {
        threads: threads.map((t) => ({
          ...serializeThread(t),
          messageCount: countByThread.get(t.id) ?? 0,
          firstMessagePreview: previewByThread.get(t.id) ?? null,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
```

Add `import { prisma } from "../db.js";` at the top of the file if not already present.

### Step 5.4: Run the test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 10/10 PASS (5 from Task 4 + 5 new).

### Step 5.5: Commit

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
git commit -m "feat(plan 1e-threads): GET /chat/threads (list with previews)"
```

---

## Task 6: `GET /chat/threads/:tid` (detail)

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/tests/chat.routes.test.ts`

### Step 6.1: Append the failing test

Append to `apps/api/tests/chat.routes.test.ts`:

```typescript
describe("GET /workspaces/:wsId/chat/threads/:tid", () => {
  it("returns the thread and messages (chronological)", async () => {
    const { cookie, wsId } = await setupProUser(`d-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "Detail" } });
    await prisma.chatMessage.create({ data: { threadId: t.id, role: "user", blocks: [{ type: "text", markdown: "first" }], createdAt: new Date("2026-05-15T10:00:00Z") } });
    await prisma.chatMessage.create({ data: { threadId: t.id, role: "assistant", blocks: [{ type: "text", markdown: "second" }], createdAt: new Date("2026-05-15T10:01:00Z") } });

    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.thread.title).toBe("Detail");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[1].role).toBe("assistant");
  });

  it("returns 404 for unknown thread id", async () => {
    const { cookie, wsId } = await setupProUser(`d-${Date.now()}@t.co`);
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/does-not-exist`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("thread_not_found");
  });

  it("returns 404 for cross-workspace ids", async () => {
    const a = await setupProUser(`d-${Date.now()}-a@t.co`);
    const b = await setupProUser(`d-${Date.now()}-b@t.co`);
    const bThread = await prisma.chatThread.create({ data: { workspaceId: b.wsId } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${a.wsId}/chat/threads/${bThread.id}`, headers: { cookie: a.cookie, "x-workspace-id": a.wsId } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("thread_not_found");
  });

  it("returns the most recent 100 messages (newest 100, chronologically ordered)", async () => {
    const { cookie, wsId } = await setupProUser(`d-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    // Seed 105 messages spread across distinct timestamps.
    for (let i = 0; i < 105; i++) {
      await prisma.chatMessage.create({
        data: {
          threadId: t.id,
          role: "user",
          blocks: [{ type: "text", markdown: `m-${i}` }],
          createdAt: new Date(2026_000_000_000 + i * 1000),
        },
      });
    }
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.messages).toHaveLength(100);
    // newest 100 → m-5 through m-104, in chronological order
    expect((body.messages[0].blocks as Array<{ markdown: string }>)[0].markdown).toBe("m-5");
    expect((body.messages[99].blocks as Array<{ markdown: string }>)[0].markdown).toBe("m-104");
  });

  it("returns 200 for archived threads (read access preserved)", async () => {
    const { cookie, wsId } = await setupProUser(`d-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, archivedAt: new Date() } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.archivedAt).not.toBeNull();
  });

  it("succeeds for viewer + free-tier", async () => {
    const { cookie, wsId, userId } = await setupProUser(`d-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({ method: "GET", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(200);
  });
});
```

### Step 6.2: Run the test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 6 new tests FAIL with 404 (no route).

### Step 6.3: Add the detail route

Append inside `chatRoutes` in `apps/api/src/routes/chat.ts`:

```typescript
  app.get("/workspaces/:id/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { id: string; tid: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const thread = await threadsService.findOwned({ threadId: params.tid, workspaceId: ctx.membership.workspaceId });
      if (!thread) return reply.code(404).send({ error: "thread_not_found" });

      // Fetch the newest 100 messages and reverse to chronological order.
      // Using orderBy asc + take 100 would return the oldest 100 — wrong for long threads.
      const recent = await prisma.chatMessage.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const messages = recent.reverse();

      return {
        thread: serializeThread(thread),
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          blocks: m.blocks,
          createdAt: m.createdAt.toISOString(),
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
```

### Step 6.4: Run the test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 16/16 PASS.

### Step 6.5: Commit

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
git commit -m "feat(plan 1e-threads): GET /chat/threads/:tid (detail with messages)"
```

---

## Task 7: `PATCH /chat/threads/:tid` (rename)

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/tests/chat.routes.test.ts`

### Step 7.1: Append the failing test

Append to `apps/api/tests/chat.routes.test.ts`:

```typescript
describe("PATCH /workspaces/:wsId/chat/threads/:tid", () => {
  it("renames the thread", async () => {
    const { cookie, wsId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "before" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "after" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.title).toBe("after");
  });

  it("title: null clears the title", async () => {
    const { cookie, wsId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "some" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.title).toBeNull();
  });

  it("renames archived threads (read+tidy access preserved)", async () => {
    const { cookie, wsId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, title: "old", archivedAt: new Date() } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "renamed-archive" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.title).toBe("renamed-archive");
  });

  it("returns 404 for cross-workspace ids", async () => {
    const a = await setupProUser(`r-${Date.now()}-a@t.co`);
    const b = await setupProUser(`r-${Date.now()}-b@t.co`);
    const bThread = await prisma.chatThread.create({ data: { workspaceId: b.wsId } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${a.wsId}/chat/threads/${bThread.id}`,
      headers: { cookie: a.cookie, "x-workspace-id": a.wsId, "content-type": "application/json" },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for viewer", async () => {
    const { cookie, wsId, userId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 402 for free tier", async () => {
    const { cookie, wsId, userId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(402);
  });

  it("rejects title longer than 200 chars", async () => {
    const { cookie, wsId } = await setupProUser(`r-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/chat/threads/${t.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { title: "x".repeat(201) },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

### Step 7.2: Run the test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 7 new tests FAIL.

### Step 7.3: Add the patch route

Add the body schema near the top of `apps/api/src/routes/chat.ts`:

```typescript
const PatchBody = z.object({
  title: z.union([z.string().min(1).max(200), z.null()]),
});
```

Append inside `chatRoutes`:

```typescript
  app.patch("/workspaces/:id/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { id: string; tid: string };
    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const updated = await threadsService.patch({
        threadId: params.tid,
        workspaceId: ctx.membership.workspaceId,
        title: parsed.data.title,
      });
      if (!updated) return reply.code(404).send({ error: "thread_not_found" });
      return { thread: serializeThread(updated) };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
```

### Step 7.4: Run the test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 23/23 PASS.

### Step 7.5: Commit

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
git commit -m "feat(plan 1e-threads): PATCH /chat/threads/:tid (rename)"
```

---

## Task 8: `DELETE /chat/threads/:tid` (archive)

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/tests/chat.routes.test.ts`

### Step 8.1: Append the failing test

Append to `apps/api/tests/chat.routes.test.ts`:

```typescript
describe("DELETE /workspaces/:wsId/chat/threads/:tid", () => {
  it("archives the thread (sets archivedAt) and returns 204", async () => {
    const { cookie, wsId } = await setupProUser(`del-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(204);
    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.archivedAt).not.toBeNull();
  });

  it("is idempotent: second DELETE on an archived thread also returns 204", async () => {
    const { cookie, wsId } = await setupProUser(`del-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, archivedAt: new Date() } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(204);
  });

  it("returns 404 for unknown thread", async () => {
    const { cookie, wsId } = await setupProUser(`del-${Date.now()}@t.co`);
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/does-not-exist`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for cross-workspace ids", async () => {
    const a = await setupProUser(`del-${Date.now()}-a@t.co`);
    const b = await setupProUser(`del-${Date.now()}-b@t.co`);
    const bThread = await prisma.chatThread.create({ data: { workspaceId: b.wsId } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${a.wsId}/chat/threads/${bThread.id}`, headers: { cookie: a.cookie, "x-workspace-id": a.wsId } });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 for viewer", async () => {
    const { cookie, wsId, userId } = await setupProUser(`del-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(403);
  });

  it("returns 402 for free tier", async () => {
    const { cookie, wsId, userId } = await setupProUser(`del-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({ method: "DELETE", url: `/workspaces/${wsId}/chat/threads/${t.id}`, headers: { cookie, "x-workspace-id": wsId } });
    expect(res.statusCode).toBe(402);
  });
});
```

### Step 8.2: Run the test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 6 new tests FAIL.

### Step 8.3: Add the delete route

Append inside `chatRoutes` in `apps/api/src/routes/chat.ts`:

```typescript
  app.delete("/workspaces/:id/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { id: string; tid: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const archived = await threadsService.archive({
        threadId: params.tid,
        workspaceId: ctx.membership.workspaceId,
      });
      if (!archived) return reply.code(404).send({ error: "thread_not_found" });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
```

### Step 8.4: Run the test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 29/29 PASS.

### Step 8.5: Commit

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
git commit -m "feat(plan 1e-threads): DELETE /chat/threads/:tid (soft archive, idempotent)"
```

---

## Task 9: History selection helper (count + token budget) + env

**Goal:** Replace the single 20-message cap with `CHAT_HISTORY_LIMIT_MESSAGES` (default 200) + `CHAT_HISTORY_BUDGET_TOKENS` (default 400 000). The selection algorithm lives in a pure helper that's unit-testable without any Gemini mocking. `turn.ts` calls it.

**Why a pure helper:** the existing chat Gemini mock (`apps/api/tests/helpers/gemini-mock.ts`) is push-based — tests queue scripted responses with `chatGeminiMock.responses.push({...})` but the mock does NOT record inbound calls. There's no way to assert on the `contents.length` Gemini saw. Extracting the selection function lets us unit-test it directly with synthetic message arrays.

**Files:**
- Modify: `apps/api/src/env.ts`
- Create: `apps/api/src/chat/history-window.ts`
- Modify: `apps/api/src/chat/turn.ts`
- Create: `apps/api/tests/chat.history-window.test.ts`

### Step 9.1: Update env schema

In `apps/api/src/env.ts`, locate this block:

```typescript
  CHAT_MODEL: z.string().optional(),
  CHAT_HISTORY_LIMIT: z.coerce.number().int().positive().optional(),
  CHAT_MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().positive().optional(),
```

Replace `CHAT_HISTORY_LIMIT` with the two new keys:

```typescript
  CHAT_MODEL: z.string().optional(),
  CHAT_HISTORY_LIMIT_MESSAGES: z.coerce.number().int().positive().optional(),
  CHAT_HISTORY_BUDGET_TOKENS: z.coerce.number().int().positive().optional(),
  CHAT_MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().positive().optional(),
```

### Step 9.2: Write the failing test for `selectHistoryWindow`

Create `apps/api/tests/chat.history-window.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { selectHistoryWindow, type HistoryCandidate } from "../src/chat/history-window.js";

function msg(
  id: string,
  blocks: unknown = [{ type: "text", markdown: id }],
  createdAt = new Date("2026-05-15T00:00:00Z"),
): HistoryCandidate {
  return { id, blocks, createdAt };
}

describe("selectHistoryWindow", () => {
  it("returns all messages chronologically when both caps are slack", () => {
    const newestFirst = [msg("c", "third"), msg("b", "second"), msg("a", "first")];
    const r = selectHistoryWindow(newestFirst, { limitMessages: 10, budgetTokens: 1_000 });
    expect(r.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("applies the count cap (keeps the N newest)", () => {
    const newestFirst = [msg("e"), msg("d"), msg("c"), msg("b"), msg("a")];
    const r = selectHistoryWindow(newestFirst, { limitMessages: 3, budgetTokens: 1_000_000 });
    expect(r.map((m) => m.id)).toEqual(["c", "d", "e"]);
  });

  it("applies the token budget (cuts older messages first)", () => {
    // Each "x".repeat(80) → JSON.stringify cost ≈ 84 chars → ~21 tokens.
    const newestFirst = [
      msg("newest", "x".repeat(80)),
      msg("mid", "x".repeat(80)),
      msg("oldest", "x".repeat(80)),
    ];
    // Budget fits 2 of 3.
    const r = selectHistoryWindow(newestFirst, { limitMessages: 100, budgetTokens: 50 });
    expect(r.map((m) => m.id)).toEqual(["mid", "newest"]);
  });

  it("keeps the newest message even when it alone exceeds the budget", () => {
    const huge = "y".repeat(8000);
    const newestFirst = [msg("only", huge)];
    const r = selectHistoryWindow(newestFirst, { limitMessages: 100, budgetTokens: 10 });
    expect(r.map((m) => m.id)).toEqual(["only"]);
  });

  it("returns empty when the input is empty", () => {
    const r = selectHistoryWindow([], { limitMessages: 100, budgetTokens: 1_000 });
    expect(r).toEqual([]);
  });

  it("count cap is applied before the token walk (oldest beyond cap are not considered)", () => {
    // 5 small messages + cap 2; oldest 3 should be untouched by budget logic.
    const newestFirst = [msg("e"), msg("d"), msg("c"), msg("b"), msg("a")];
    const r = selectHistoryWindow(newestFirst, { limitMessages: 2, budgetTokens: 1_000_000 });
    expect(r.map((m) => m.id)).toEqual(["d", "e"]);
  });
});
```

### Step 9.3: Run the test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.history-window.test.ts
```
Expected: FAIL with `Cannot find module '../src/chat/history-window.js'`.

### Step 9.4: Implement `selectHistoryWindow`

Create `apps/api/src/chat/history-window.ts`:

```typescript
import { estimateMessageTokens } from "./token-estimate.js";

export type HistoryCandidate = {
  id: string;
  blocks: unknown;
  createdAt: Date;
};

export type WindowOptions = {
  limitMessages: number;
  budgetTokens: number;
};

/**
 * Pick a chronological slice of recent chat messages to send to the LLM.
 *
 * Input `newestFirst` is ordered from newest to oldest (matching Prisma's
 * `orderBy: { createdAt: "desc" }` shape). The returned slice is chronological
 * (oldest → newest) and bounded by both `limitMessages` (count cap) and
 * `budgetTokens` (rough JSON-length heuristic). Whichever cap hits first wins.
 *
 * If the newest single message alone exceeds the budget, it is still returned
 * (cutting it would leave an empty history, which the LLM can't act on).
 */
export function selectHistoryWindow<T extends HistoryCandidate>(
  newestFirst: T[],
  opts: WindowOptions,
): T[] {
  const capped = newestFirst.slice(0, opts.limitMessages);
  const selected: T[] = [];
  let used = 0;
  for (const msg of capped) {
    const cost = estimateMessageTokens(msg.blocks);
    if (selected.length > 0 && used + cost > opts.budgetTokens) break;
    selected.push(msg);
    used += cost;
  }
  return selected.reverse();
}
```

### Step 9.5: Run the test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.history-window.test.ts
```
Expected: 6/6 PASS.

### Step 9.6: Wire the helper into `turn.ts`

In `apps/api/src/chat/turn.ts`:

1. Add the import near the other chat imports:
   ```typescript
   import { selectHistoryWindow } from "./history-window.js";
   ```

2. Replace the existing history-loading block. Current code at the top of `processChatTurn` (lines 69 and 75–80):
   ```typescript
   const HISTORY_LIMIT = env.CHAT_HISTORY_LIMIT ?? 20;
   // ...
   const recent = await prisma.chatMessage.findMany({
     where: { threadId: thread.id },
     orderBy: { createdAt: "desc" },
     take: HISTORY_LIMIT,
   });
   const historyChrono = [...recent].reverse();
   ```

   Replace with:
   ```typescript
   const HISTORY_LIMIT_MESSAGES = env.CHAT_HISTORY_LIMIT_MESSAGES ?? 200;
   const HISTORY_BUDGET_TOKENS = env.CHAT_HISTORY_BUDGET_TOKENS ?? 400_000;
   // ...
   const recent = await prisma.chatMessage.findMany({
     where: { threadId: thread.id },
     orderBy: { createdAt: "desc" },
     take: HISTORY_LIMIT_MESSAGES,
   });
   const historyChrono = selectHistoryWindow(recent, {
     limitMessages: HISTORY_LIMIT_MESSAGES,
     budgetTokens: HISTORY_BUDGET_TOKENS,
   });
   ```

### Step 9.7: Run the existing turn suite + history-window suite

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.turn.test.ts tests/chat.history-window.test.ts
```
Expected: existing turn tests still PASS (the defaults make them behaviour-equivalent for short histories), plus 6/6 new tests PASS.

### Step 9.8: Commit

```bash
git add apps/api/src/env.ts apps/api/src/chat/history-window.ts apps/api/src/chat/turn.ts apps/api/tests/chat.history-window.test.ts
git commit -m "feat(plan 1e-threads): selectHistoryWindow helper (count + token budget) + env"
```

---

## Task 10: `POST /chat/threads/:tid/messages`

**Goal:** Send a user message to a specific thread, run the chat turn, persist user + assistant messages, advance `lastMessageAt`. Final route in the new chat surface.

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/tests/chat.routes.test.ts`

### Step 10.1: Append the failing test

Append to `apps/api/tests/chat.routes.test.ts`:

```typescript
describe("POST /workspaces/:wsId/chat/threads/:tid/messages", () => {
  it("posts a user message, runs a turn, returns assistant message + tool calls", async () => {
    const { cookie, wsId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    chatGeminiMock.responses.push({ text: "Hi back" });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "Hello" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.threadId).toBe(t.id);
    expect(body.userMessage.role).toBe("user");
    expect(body.assistantMessage.role).toBe("assistant");
    expect(body.toolCalls).toEqual([]);

    const row = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.lastMessageAt).not.toBeNull();
  });

  it("returns 404 for archived thread", async () => {
    const { cookie, wsId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId, archivedAt: new Date() } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("thread_not_found");
  });

  it("returns 404 for cross-workspace thread", async () => {
    const a = await setupProUser(`m-${Date.now()}-a@t.co`);
    const b = await setupProUser(`m-${Date.now()}-b@t.co`);
    const bThread = await prisma.chatThread.create({ data: { workspaceId: b.wsId } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${a.wsId}/chat/threads/${bThread.id}/messages`,
      headers: { cookie: a.cookie, "x-workspace-id": a.wsId, "content-type": "application/json" },
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 402 for free tier", async () => {
    const { cookie, wsId, userId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.user.update({ where: { id: userId }, data: { trialEndsAt: new Date(Date.now() - 86400000), trialConsumed: true } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(402);
  });

  it("returns 403 for viewer", async () => {
    const { cookie, wsId, userId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    await prisma.membership.update({ where: { userId_workspaceId: { userId, workspaceId: wsId } }, data: { role: "viewer" } });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "hi" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects empty text and text longer than 4000 chars with 400", async () => {
    const { cookie, wsId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    const empty = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "" },
    });
    expect(empty.statusCode).toBe(400);
    const huge = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "x".repeat(4001) },
    });
    expect(huge.statusCode).toBe(400);
  });

  it("on Gemini failure returns 500 chat_provider_error and does NOT persist the assistant message", async () => {
    const { cookie, wsId } = await setupProUser(`m-${Date.now()}@t.co`);
    const t = await prisma.chatThread.create({ data: { workspaceId: wsId } });
    chatGeminiMock.responses.push(new Error("network down"));
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/chat/threads/${t.id}/messages`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { text: "Hello" },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("chat_provider_error");
    const msgs = await prisma.chatMessage.findMany({ where: { threadId: t.id } });
    // Existing behavior: the user message persists before the turn runs.
    // The assistant message is not created, and lastMessageAt should reflect the user message only.
    expect(msgs.every((m) => m.role !== "assistant")).toBe(true);
  });
});
```

Add `chatGeminiMock` to the top imports of `chat.routes.test.ts`:

```typescript
import { resetGeminiMock, chatGeminiMock } from "./helpers/gemini-mock.js";
```

(The existing test file imports only `resetGeminiMock`; add `chatGeminiMock`.)

### Step 10.2: Run the test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 7 new tests FAIL with 404 (no route).

### Step 10.3: Add the messages route

Append to `apps/api/src/routes/chat.ts`:

1. Add an import for `processChatTurn` near the top:
   ```typescript
   import { processChatTurn } from "../chat/turn.js";
   ```

2. Add the body schema:
   ```typescript
   const MessageBody = z.object({
     text: z.string().min(1).max(4000),
   });
   ```

3. Append inside `chatRoutes`:
   ```typescript
     app.post("/workspaces/:id/chat/threads/:tid/messages", async (req, reply) => {
       const params = req.params as { id: string; tid: string };
       const parsed = MessageBody.safeParse(req.body);
       if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

       try {
         const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
         if (ctx.membership.workspaceId !== params.id) {
           return reply.code(400).send({ error: "workspace_mismatch" });
         }
         const tier = await effectiveTier(ctx.session.userId);
         if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

         const thread = await threadsService.findOwned({ threadId: params.tid, workspaceId: ctx.membership.workspaceId });
         if (!thread || thread.archivedAt) return reply.code(404).send({ error: "thread_not_found" });

         // Each (message create + thread lastMessageAt bump) is wrapped in a
         // transaction so an unexpected error between the two writes can't leave
         // list ordering stale relative to the message that exists.
         const userMessage = await prisma.$transaction(async (tx) => {
           const m = await tx.chatMessage.create({
             data: {
               threadId: thread.id,
               role: "user",
               blocks: [{ type: "text", markdown: parsed.data.text }],
             },
           });
           await tx.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: m.createdAt } });
           return m;
         });

         let turn: Awaited<ReturnType<typeof processChatTurn>>;
         try {
           turn = await processChatTurn(app.fina.env, { id: thread.id, workspaceId: thread.workspaceId }, ctx.session.userId);
         } catch (e) {
           console.error("chat provider failed", { threadId: thread.id, err: e });
           return reply.code(500).send({ error: "chat_provider_error" });
         }

         const assistantMessage = await prisma.$transaction(async (tx) => {
           const m = await tx.chatMessage.create({
             data: {
               threadId: thread.id,
               role: "assistant",
               blocks: [{ type: "text", markdown: turn.assistantText }],
             },
           });
           await tx.chatThread.update({ where: { id: thread.id }, data: { lastMessageAt: m.createdAt } });
           return m;
         });

         return {
           threadId: thread.id,
           userMessage: {
             id: userMessage.id,
             role: userMessage.role,
             blocks: userMessage.blocks,
             createdAt: userMessage.createdAt.toISOString(),
           },
           assistantMessage: {
             id: assistantMessage.id,
             role: assistantMessage.role,
             blocks: assistantMessage.blocks,
             createdAt: assistantMessage.createdAt.toISOString(),
           },
           toolCalls: turn.toolCalls,
         };
       } catch (e) {
         if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
         throw e;
       }
     });
   ```

### Step 10.4: Run the test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```
Expected: 36/36 PASS.

### Step 10.5: Run the full api suite + typecheck

Run:
```bash
pnpm --filter @fina/api test
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json
```
Expected: full suite green; typecheck has only the two pre-existing `turn.ts` errors (lines 60 and 112 — unchanged by this plan).

### Step 10.6: Commit

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
git commit -m "feat(plan 1e-threads): POST /chat/threads/:tid/messages + lastMessageAt updates"
```

---

## Task 11: E2E spec

**Goal:** Cover the multi-thread happy path end-to-end with real Gemini, plus the archive isolation case.

**Files:**
- Create: `e2e/plan-1e-threads.spec.ts`

### Step 11.1: Write the spec

Create `e2e/plan-1e-threads.spec.ts`:

```typescript
/**
 * E2E — Plan 1E-threads. Real Gemini API call.
 *
 * Verifies multi-thread isolation: two threads in the same workspace each get
 * their own conversation, archive blocks message-send but preserves read access.
 *
 * Run:
 *   GEMINI_API_KEY=... DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
 *   pnpm exec playwright test --grep "plan 1e-threads"
 *
 * Skipped without DB + GEMINI_API_KEY.
 */

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";

const API = process.env.API_URL ?? "http://localhost:4000";

const HAS_DB = (() => {
  try {
    execSync(`docker exec fina-postgres-dev psql -U fina -d fina -tAc "SELECT 1"`, { encoding: "utf8", timeout: 5_000 });
    return true;
  } catch { return false; }
})();
const HAS_GEMINI = !!process.env.GEMINI_API_KEY;

function psql(sql: string): string {
  return execSync(
    `docker exec fina-postgres-dev psql -q -U fina -d fina -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: "utf8" },
  ).trim();
}

test.describe.configure({ mode: "serial" });

test.describe("plan 1e-threads — real Gemini, multi-thread isolation", () => {
  test.skip(!HAS_DB || !HAS_GEMINI, "Requires DB + GEMINI_API_KEY");

  // Gemini free tier: 10 req/min, 20 req/day. Each turn ≈ 2 LLM calls.
  // Pace tests to stay under the per-minute cap when chaining cases.
  const GEMINI_PACE_MS = Number(process.env.E2E_GEMINI_PACE_MS ?? 13_000);
  test.beforeEach(async () => { await new Promise((r) => setTimeout(r, GEMINI_PACE_MS)); });
  test.setTimeout(90_000);

  test.afterEach(async ({ page }) => {
    try {
      psql(`DELETE FROM workspaces WHERE name LIKE '%E2E Threads%'`);
      psql(`DELETE FROM users WHERE email LIKE '%@e2e-threads.test'`);
    } catch { /* ignore */ }
    await page.request.post(`${API}/api/auth/sign-out`).catch(() => {});
  });

  test("two threads in one workspace stay isolated", async ({ page }) => {
    const email = `mt-${Date.now()}@e2e-threads.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Threads" },
      headers: { "content-type": "application/json" },
    });
    expect(sign.ok()).toBe(true);
    const { user: { id: userId } } = await sign.json() as { user: { id: string } };

    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0].id;
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    const createA = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Thread A" },
    });
    expect(createA.status()).toBe(201);
    const threadAId = (await createA.json()).thread.id as string;

    const createB = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Thread B" },
    });
    expect(createB.status()).toBe(201);
    const threadBId = (await createB.json()).thread.id as string;

    const msgA = await page.request.post(`${API}/workspaces/${wsId}/chat/threads/${threadAId}/messages`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "Remember the codeword PINEAPPLE" },
    });
    expect(msgA.ok()).toBe(true);

    const msgB = await page.request.post(`${API}/workspaces/${wsId}/chat/threads/${threadBId}/messages`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "What's the codeword I gave you?" },
    });
    expect(msgB.ok()).toBe(true);
    const bBody = await msgB.json();
    const bText = (bBody.assistantMessage.blocks[0].markdown as string).toLowerCase();
    // Thread B has no PINEAPPLE in its history; the assistant should not echo it.
    expect(bText.includes("pineapple")).toBe(false);

    const list = await page.request.get(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId },
    });
    const titles = (await list.json()).threads.map((t: { title: string }) => t.title);
    expect(titles.sort()).toEqual(["Thread A", "Thread B"]);
  });

  test("archived thread blocks message-send but stays readable", async ({ page }) => {
    const email = `ar-${Date.now()}@e2e-threads.test`;
    const sign = await page.request.post(`${API}/api/auth/sign-up/email`, {
      data: { email, password: "password-e2e-1234", name: "E2E Threads" },
      headers: { "content-type": "application/json" },
    });
    const { user: { id: userId } } = await sign.json() as { user: { id: string } };
    const wsRes = await page.request.get(`${API}/workspaces`);
    const wsId = ((await wsRes.json()) as { workspaces: { id: string }[] }).workspaces[0].id;
    psql(`UPDATE users SET "trialEndsAt" = NOW() + INTERVAL '7 days', "trialConsumed" = false WHERE id = '${userId}'`);

    const create = await page.request.post(`${API}/workspaces/${wsId}/chat/threads`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { title: "Doomed" },
    });
    const tid = (await create.json()).thread.id as string;

    const firstMsg = await page.request.post(`${API}/workspaces/${wsId}/chat/threads/${tid}/messages`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "say hi" },
    });
    expect(firstMsg.ok()).toBe(true);

    const del = await page.request.delete(`${API}/workspaces/${wsId}/chat/threads/${tid}`, {
      headers: { "x-workspace-id": wsId },
    });
    expect(del.status()).toBe(204);

    const blockedMsg = await page.request.post(`${API}/workspaces/${wsId}/chat/threads/${tid}/messages`, {
      headers: { "x-workspace-id": wsId, "content-type": "application/json" },
      data: { text: "after archive" },
    });
    expect(blockedMsg.status()).toBe(404);

    const detail = await page.request.get(`${API}/workspaces/${wsId}/chat/threads/${tid}`, {
      headers: { "x-workspace-id": wsId },
    });
    expect(detail.status()).toBe(200);
    const body = await detail.json();
    expect(body.thread.archivedAt).not.toBeNull();
    expect(body.messages.length).toBeGreaterThan(0);
  });
});
```

### Step 11.2: Verify the spec is discovered

Run:
```bash
pnpm exec playwright test --list 2>&1 | grep "plan-1e-threads"
```
Expected: 2 tests listed under `plan-1e-threads.spec.ts`. Do not run the suite here — quota is precious; this listing only confirms the spec compiles and Playwright discovers it.

### Step 11.3: Commit

```bash
git add e2e/plan-1e-threads.spec.ts
git commit -m "test(plan 1e-threads): Playwright E2E — isolation + archive flow"
```

---

## Acceptance Verification

After Task 11, walk through the spec's section 10 acceptance criteria. Each row should be observable in the final commit set.

- [ ] `chat_threads.type` column and `ChatThreadType` enum gone from schema + DB.
- [ ] `chat_threads` has nullable `title`, `lastMessageAt`, `archivedAt`, and the new compound index.
- [ ] A workspace can hold ≥ 2 threads (covered by Task 5 list test and the E2E spec).
- [ ] All six new routes work: POST threads (Task 4), POST messages (Task 10), GET list (Task 5), GET detail (Task 6), PATCH (Task 7), DELETE (Task 8).
- [ ] Old `POST /chat/message` and `GET /chat/thread` removed (Task 1).
- [ ] Mutating routes require Pro + editor; GET routes require viewer and are not tier-gated (Tasks 4–10).
- [ ] Cross-workspace access returns 404 `thread_not_found` (Tasks 6, 7, 8, 10).
- [ ] Archived thread message-send returns 404; PATCH and GET still work (Tasks 7, 6, 10, E2E).
- [ ] `CHAT_HISTORY_LIMIT_MESSAGES` (use-site default 200) and `CHAT_HISTORY_BUDGET_TOKENS` (use-site default 400 000) honored; old `CHAT_HISTORY_LIMIT` is gone (Task 9).
- [ ] History selection cuts at whichever cap hits first, always chronological (Task 9 tests).
- [ ] `lastMessageAt` advances on every message create (Task 10 test).
- [ ] Existing `adhoc` thread rows survive the migration with backfilled `lastMessageAt` (verified by the migration SQL; engineers can spot-check `SELECT id, "lastMessageAt" FROM chat_threads;` against a snapshot of dev data).
- [ ] All 11 existing chat tools still work — registry unchanged, tools untouched, their tests still green.
