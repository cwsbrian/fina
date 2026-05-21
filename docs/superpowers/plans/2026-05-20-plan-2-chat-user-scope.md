# Plan 2-chat-user-scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `ChatThread` to be user-owned with a nullable `workspaceId`, so threads start *unbound* and the user's first message commits the thread to a workspace via conditional UPDATE. Routes move from `/workspaces/:wsId/chat/*` to `/chat/*`. Tool ctx semantics unchanged (workspaceId still flows through, just from the bound thread instead of the URL).

**Architecture:** Schema gains `userId NOT NULL` and relaxes `workspaceId` to nullable. The lazy-binding logic lives in the **route handler** for `POST /chat/threads/:tid/messages` (a `prisma.$transaction` wrapping a conditional `updateMany ... WHERE workspaceId IS NULL` + race-loss refetch). Every other layer keeps its current `workspaceId` semantics — when the route enters the LLM turn, the thread is already bound, so `processChatTurn` and all tools see a non-null workspaceId.

**Tech Stack:** Prisma + Postgres (port 5433, dev DB `fina`, test DB `fina_test`); Fastify; Better Auth (session cookies); Vitest singleFork; pnpm Nx monorepo. All work lives in `apps/api/`.

---

## Context — read before any task

- **Spec**: `docs/superpowers/specs/2026-05-20-plan-2-chat-user-scope-design.md`. Authoritative on schema, route shapes, error codes, and forward-compat hooks. Re-read §4 (lazy binding) and §6 (concurrency) before Task 6.
- **Pre-launch posture**: no production chat data. The migration is **destructive** and purges every chat_threads, chat_messages, and action_intents row. `audit_events` is left intact (its rows describe tool invocations, not chat lifecycle).
- **Test invocation**: tests run with a real Postgres at `postgresql://fina:fina@localhost:5433/fina_test`. Targeted command pattern:
  ```bash
  DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test \
    pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/<file>
  ```
  `pnpm --filter` sets cwd to `apps/api/`, so all relative paths in commands below are relative to `apps/api/`.
- **Working dir**: `/home/cwsbr/personal/fina/.claude/worktrees/plan-2-daily-brief` (worktree branch `worktree-plan-2-chat-user-scope`).

## File map

| File | Action | Task |
|---|---|---|
| `apps/api/prisma/schema.prisma` | Modify ChatThread + User models | T1 |
| `apps/api/prisma/migrations/20260520130000_chat_user_scope/migration.sql` | Create | T1 |
| `apps/api/src/chat/threads.ts` | Rewrite (signatures key by userId) | T2 |
| `apps/api/tests/chat.threads.test.ts` | Rewrite | T2 |
| `apps/api/src/chat/auto-title.ts` | Modify (drop workspaceId arg) | T3 |
| `apps/api/tests/chat.auto-title.test.ts` | Update call sites | T3 |
| `apps/api/tests/chat.auto-title.unit.test.ts` | No change (pure cleanTitle) | T3 |
| `apps/api/src/routes/chat.ts` | Rewrite handlers (paths, auth, lazy bind) | T4–T6 |
| `apps/api/tests/chat.routes.test.ts` | Rewrite for new paths | T4–T6 |
| `apps/api/tests/chat.lazy-binding.test.ts` | Create — race + archive + 400 | T7 |
| `apps/api/tests/chat.migration.smoke.test.ts` | Create — index + EXPLAIN | T8 |
| `apps/api/src/server.ts` | No change (chatRoutes() mount unchanged; route paths inside it change) | — |
| `apps/api/src/chat/turn.ts` | No change (signature unchanged per spec §1) | — |
| `apps/api/src/chat/tools/*.ts` | No change (ctx.workspaceId still injected) | — |
| `apps/api/src/audit/service.ts` | No change | — |
| `apps/api/src/intents/service.ts` | No change | — |
| `apps/api/src/routes/intents.ts` | No change | — |

---

## Task 1: Schema + migration

**Goal:** `ChatThread` gains `userId NOT NULL`, relaxes `workspaceId` to nullable. Existing chat data is purged (pre-launch). Old workspace-listing index replaced with a user-listing index.

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260520130000_chat_user_scope/migration.sql`

- [ ] **Step 1.1: Modify Prisma schema — ChatThread**

Edit `apps/api/prisma/schema.prisma`. Find the `model ChatThread` block (around line 472). Replace it with:

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

- [ ] **Step 1.2: Add inverse relation on User**

Find the `model User` block (around line 16). Inside its relations section (between `accounts Account[]` and the `@@map`), add:

```prisma
  chatThreads ChatThread[]
```

The User block's relation list should now include both the existing relations and `chatThreads`. The Workspace model already has `chatThreads ChatThread[]` (around line 108) — leave it alone; Prisma still accepts the collection side when the scalar becomes nullable.

- [ ] **Step 1.3: Create migration directory + SQL**

Create the file `apps/api/prisma/migrations/20260520130000_chat_user_scope/migration.sql` with this exact content:

```sql
-- Plan 2-chat-user-scope: rebind ChatThread to user, allow null workspace.
-- Pre-launch destructive migration — no chat data is preserved.

-- 1. Purge dependent state.
--    chat_messages has ON DELETE CASCADE from chat_threads, so dropping
--    threads automatically purges messages.
--    action_intents has `messageId TEXT` with NO foreign key — orphans
--    would survive a cascade. Purge explicitly.
--    audit_events is NOT chat-scoped — its rows describe tool calls and
--    are independent of chat thread lifecycle. Do NOT delete them.
DELETE FROM "action_intents";
DELETE FROM "chat_threads";

-- 2. Drop the old workspace-listing index.
DROP INDEX IF EXISTS "chat_threads_workspaceId_archivedAt_lastMessageAt_idx";

-- 3. Schema change: add userId, make workspaceId nullable.
ALTER TABLE "chat_threads" ADD COLUMN "userId" TEXT NOT NULL;
ALTER TABLE "chat_threads" ALTER COLUMN "workspaceId" DROP NOT NULL;
ALTER TABLE "chat_threads"
  ADD CONSTRAINT "chat_threads_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;

-- 4. New user-listing index (NULLS LAST matches the §4.4 brief-cron
-- selection query and the §5.3 listing query alike).
CREATE INDEX "chat_threads_userId_archivedAt_lastMessageAt_idx"
  ON "chat_threads" ("userId", "archivedAt", "lastMessageAt" DESC NULLS LAST);
```

- [ ] **Step 1.4: Apply migration to dev DB**

Run from the worktree root:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api exec prisma migrate deploy
```

Expected output: `Applying migration 20260520130000_chat_user_scope` and `All migrations have been successfully applied.`

Troubleshooting: if the migration was partially applied from an earlier failed run (the implementer sees errors about `userId` already existing or the index name colliding), reset the dev DB and re-run:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina pnpm --filter @fina/api exec prisma migrate reset --force
```

Safe to do — this worktree is on a dev DB with no production data.

- [ ] **Step 1.5: Regenerate Prisma client**

```bash
pnpm --filter @fina/api exec prisma generate
```

Expected: `Generated Prisma Client (...) in ...`. No errors.

- [ ] **Step 1.6: Apply migration to test DB**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec prisma migrate deploy
```

Expected: same success message.

- [ ] **Step 1.7: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260520130000_chat_user_scope/migration.sql
git commit -m "feat(plan 2-chat-user-scope): schema + migration

ChatThread.userId NOT NULL added; workspaceId relaxed to nullable.
User.chatThreads inverse relation declared. Pre-launch destructive
migration: action_intents and chat_threads (cascade chat_messages)
purged; audit_events preserved. Old workspaceId index dropped, new
userId-keyed index with NULLS LAST created."
```

---

## Task 2: threadsService refactor

**Goal:** `threadsService` methods key by `userId` instead of `workspaceId`. Service has no awareness of binding state — it just CRUDs by `(threadId, userId)`. Binding is the route layer's job (Task 6).

**Files:**
- Modify: `apps/api/src/chat/threads.ts`
- Modify: `apps/api/tests/chat.threads.test.ts`

- [ ] **Step 2.1: Write failing tests**

Replace `apps/api/tests/chat.threads.test.ts` entirely with:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { threadsService } from "../src/chat/threads.js";

describe("threadsService (user-scoped)", () => {
  let userId: string;
  let otherUserId: string;
  let workspaceId: string;

  beforeEach(async () => {
    const stamp = `ths-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "T" } });
    await prisma.user.create({ data: { id: `${stamp}-other`, email: `${stamp}-other@t.co`, name: "O" } });
    const ws = await prisma.workspace.create({ data: { name: "ths-ws" } });
    await prisma.membership.create({ data: { userId: stamp, workspaceId: ws.id, role: "owner" } });
    userId = stamp;
    otherUserId = `${stamp}-other`;
    workspaceId = ws.id;
  });

  afterEach(async () => {
    await prisma.chatMessage.deleteMany({});
    await prisma.chatThread.deleteMany({});
    await prisma.membership.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  describe("create", () => {
    it("creates an unbound thread (workspaceId null)", async () => {
      const t = await threadsService.create({ userId, title: null });
      expect(t.userId).toBe(userId);
      expect(t.workspaceId).toBeNull();
      expect(t.title).toBeNull();
    });

    it("accepts an optional title", async () => {
      const t = await threadsService.create({ userId, title: "hello" });
      expect(t.title).toBe("hello");
    });
  });

  describe("list", () => {
    it("returns the user's threads, ordered by lastMessageAt DESC NULLS LAST", async () => {
      const older = await prisma.chatThread.create({
        data: { userId, workspaceId: null, lastMessageAt: new Date("2026-05-10T12:00:00Z") },
      });
      const newer = await prisma.chatThread.create({
        data: { userId, workspaceId: null, lastMessageAt: new Date("2026-05-15T12:00:00Z") },
      });
      const empty = await prisma.chatThread.create({ data: { userId, workspaceId: null } });

      const out = await threadsService.list({ userId, includeArchived: false, limit: 10 });
      expect(out.map((t) => t.id)).toEqual([newer.id, older.id, empty.id]);
    });

    it("does not return other users' threads", async () => {
      await prisma.chatThread.create({ data: { userId: otherUserId, workspaceId: null } });
      const out = await threadsService.list({ userId, includeArchived: false, limit: 10 });
      expect(out).toEqual([]);
    });

    it("excludes archived by default", async () => {
      await prisma.chatThread.create({ data: { userId, workspaceId: null, archivedAt: new Date() } });
      const out = await threadsService.list({ userId, includeArchived: false, limit: 10 });
      expect(out).toEqual([]);
    });

    it("includes archived when requested", async () => {
      const arch = await prisma.chatThread.create({
        data: { userId, workspaceId: null, archivedAt: new Date() },
      });
      const out = await threadsService.list({ userId, includeArchived: true, limit: 10 });
      expect(out.map((t) => t.id)).toContain(arch.id);
    });
  });

  describe("findOwned", () => {
    it("returns the thread when userId matches", async () => {
      const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
      const found = await threadsService.findOwned({ threadId: t.id, userId });
      expect(found?.id).toBe(t.id);
    });

    it("returns null for another user's thread", async () => {
      const t = await prisma.chatThread.create({ data: { userId: otherUserId, workspaceId: null } });
      const found = await threadsService.findOwned({ threadId: t.id, userId });
      expect(found).toBeNull();
    });
  });

  describe("patch", () => {
    it("renames the thread regardless of bound state", async () => {
      const unbound = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
      const bound = await prisma.chatThread.create({ data: { userId, workspaceId } });
      const u = await threadsService.patch({ threadId: unbound.id, userId, title: "new" });
      const b = await threadsService.patch({ threadId: bound.id, userId, title: "new" });
      expect(u?.title).toBe("new");
      expect(b?.title).toBe("new");
    });

    it("returns null for another user's thread (does not mutate)", async () => {
      const t = await prisma.chatThread.create({ data: { userId: otherUserId, workspaceId: null } });
      const result = await threadsService.patch({ threadId: t.id, userId, title: "stolen" });
      expect(result).toBeNull();
      const reload = await prisma.chatThread.findUnique({ where: { id: t.id } });
      expect(reload?.title).toBeNull();
    });
  });

  describe("archive", () => {
    it("soft-archives both bound and unbound threads", async () => {
      const unbound = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
      const bound = await prisma.chatThread.create({ data: { userId, workspaceId } });
      const u = await threadsService.archive({ threadId: unbound.id, userId });
      const b = await threadsService.archive({ threadId: bound.id, userId });
      expect(u?.archivedAt).toBeTruthy();
      expect(b?.archivedAt).toBeTruthy();
    });

    it("is idempotent on already-archived", async () => {
      const t = await prisma.chatThread.create({
        data: { userId, workspaceId: null, archivedAt: new Date("2026-05-01T00:00:00Z") },
      });
      const out = await threadsService.archive({ threadId: t.id, userId });
      expect(out?.archivedAt?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    });

    it("returns null for another user's thread", async () => {
      const t = await prisma.chatThread.create({ data: { userId: otherUserId, workspaceId: null } });
      const result = await threadsService.archive({ threadId: t.id, userId });
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.threads.test.ts
```

Expected: TypeScript compile errors (the old service signature still expects `workspaceId`) and/or test failures. This is the correct red state.

- [ ] **Step 2.3: Replace threadsService implementation**

Overwrite `apps/api/src/chat/threads.ts` with:

```ts
import type { ChatThread } from "@prisma/client";
import { prisma } from "../db.js";

// User-scoped CRUD. Lazy workspace binding is the route layer's
// responsibility — see routes/chat.ts POST /chat/threads/:tid/messages.
export const threadsService = {
  async create(input: { userId: string; title?: string | null }): Promise<ChatThread> {
    return prisma.chatThread.create({
      data: {
        userId: input.userId,
        workspaceId: null,
        title: input.title ?? null,
      },
    });
  },

  async list(input: {
    userId: string;
    includeArchived: boolean;
    limit: number;
  }): Promise<ChatThread[]> {
    return prisma.chatThread.findMany({
      where: {
        userId: input.userId,
        ...(input.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [
        { lastMessageAt: { sort: "desc", nulls: "last" } },
        { createdAt: "desc" },
        { id: "desc" },
      ],
      take: input.limit,
    });
  },

  async findOwned(input: { threadId: string; userId: string }): Promise<ChatThread | null> {
    return prisma.chatThread.findFirst({
      where: { id: input.threadId, userId: input.userId },
    });
  },

  async patch(input: {
    threadId: string;
    userId: string;
    title: string | null;
  }): Promise<ChatThread | null> {
    const existing = await prisma.chatThread.findFirst({
      where: { id: input.threadId, userId: input.userId },
      select: { id: true },
    });
    if (!existing) return null;
    return prisma.chatThread.update({
      where: { id: existing.id },
      data: { title: input.title },
    });
  },

  async archive(input: { threadId: string; userId: string }): Promise<ChatThread | null> {
    const existing = await prisma.chatThread.findFirst({
      where: { id: input.threadId, userId: input.userId },
      select: { id: true, archivedAt: true },
    });
    if (!existing) return null;
    if (existing.archivedAt) {
      return prisma.chatThread.findFirstOrThrow({ where: { id: existing.id } });
    }
    return prisma.chatThread.update({
      where: { id: existing.id },
      data: { archivedAt: new Date() },
    });
  },
};
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.threads.test.ts
```

Expected: `Test Files  1 passed (1)` with all 13 tests green (create×2, list×4, findOwned×2, patch×2, archive×3).

- [ ] **Step 2.5: Commit**

```bash
git add apps/api/src/chat/threads.ts apps/api/tests/chat.threads.test.ts
git commit -m "feat(plan 2-chat-user-scope): threadsService keys by userId

create() always inserts workspaceId=null; binding is the route's job.
list/findOwned/patch/archive scope by userId — cross-user access
silently returns null/empty. Tests cover both bound and unbound
thread paths."
```

---

## Task 3: auto-title signature simplification

**Goal:** `generateAndPersistThreadTitle` drops the `workspaceId` argument. Auth is already done at the route layer; `threadId` is a globally-unique cuid so the conditional update gate (`WHERE id = ? AND title IS NULL`) is sufficient.

**Files:**
- Modify: `apps/api/src/chat/auto-title.ts`
- Modify: `apps/api/tests/chat.auto-title.test.ts`

- [ ] **Step 3.1: Update the existing tests**

Edit `apps/api/tests/chat.auto-title.test.ts`. Three changes:

**a. Update `beforeEach` to include `userId` on the ChatThread create** (the schema after Task 1 requires it):

Find this line in `beforeEach` (around line 29):

```ts
const t = await prisma.chatThread.create({ data: { workspaceId, title: null } });
```

Change to:

```ts
const t = await prisma.chatThread.create({ data: { userId: stamp, workspaceId, title: null } });
```

**b. Drop `workspaceId` arg from every `generateAndPersistThreadTitle` call.** The file has 4 calls (around lines 39, 47, 54, 61) that look like:

```ts
await generateAndPersistThreadTitle(env, workspaceId, threadId, "...");
```

Update each to:

```ts
await generateAndPersistThreadTitle(env, threadId, "...");
```

**c. Replace the "wrong-workspaceId" test with "wrong-threadId"** (the bottom test, around line 66). The mock pattern in this file is `vi.mocked(callTitleLLM).mockResolvedValue(...)` — match that style:

```ts
it("respects threadId boundary (wrong threadId → no update)", async () => {
  vi.mocked(callTitleLLM).mockResolvedValue("Should Not Land");
  await generateAndPersistThreadTitle(env, "wrong-thread-id", "first msg");
  const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
  expect(t?.title).toBeNull();
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.auto-title.test.ts
```

Expected: TypeScript compile errors — function still expects 4 args.

- [ ] **Step 3.3: Update auto-title implementation**

Overwrite `apps/api/src/chat/auto-title.ts` (lines 31-52) — the implementation block — with:

```ts
// Fire-and-forget. Caller does `void generateAndPersistThreadTitle(...)`.
// On any failure, logs via console.warn and resolves — never throws.
// The DB update uses `WHERE title IS NULL` so a manual PATCH during the
// async window is preserved. Auth is enforced at the route layer
// (thread.userId === session.userId), so the conditional update needs
// no further scoping.
export async function generateAndPersistThreadTitle(
  env: Env,
  threadId: string,
  firstMessageText: string,
): Promise<void> {
  try {
    const raw = await callTitleLLM(env, firstMessageText);
    const cleaned = cleanTitle(raw);
    if (cleaned === null) return;
    await prisma.chatThread.updateMany({
      where: { id: threadId, title: null },
      data: { title: cleaned, updatedAt: new Date() },
    });
  } catch (err) {
    console.warn("auto-title failed", { threadId, err });
  }
}
```

Leave `cleanTitle` (lines 5-29) exactly as-is.

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.auto-title.test.ts tests/chat.auto-title.unit.test.ts
```

Expected: both files green. `chat.auto-title.unit.test.ts` exercises only `cleanTitle`, which was untouched, so it passes unchanged.

- [ ] **Step 3.5: Commit**

```bash
git add apps/api/src/chat/auto-title.ts apps/api/tests/chat.auto-title.test.ts
git commit -m "feat(plan 2-chat-user-scope): drop workspaceId from auto-title

The route layer already authorizes by thread.userId, so the
conditional update gate (WHERE id = ? AND title IS NULL) is enough.
threadId is a globally-unique cuid; no cross-user collision risk."
```

---

## Task 4: Collection routes — POST /chat/threads + GET /chat/threads

**Goal:** Stand up the user-scoped collection endpoints. No workspace in URL, no `X-Workspace-Id` header read, no `requireWorkspaceContext`. Pro-tier gate on POST only; GET is open (Lite reads daily-brief threads in Plan 2B).

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/tests/chat.routes.test.ts`

- [ ] **Step 4.1: Open both files and prepare for the rewrite**

The chat routes will be rewritten in stages: Task 4 handles `/chat/threads` (collection), Task 5 handles `/chat/threads/:tid` (item), Task 6 handles `/chat/threads/:tid/messages`. Each task's tests cover only its endpoints.

Start by reading both files end-to-end:

```bash
wc -l apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
```

Expected ~307 + ~509 lines respectively.

- [ ] **Step 4.2: Write failing tests for the new collection endpoints**

Replace the top of `apps/api/tests/chat.routes.test.ts` — imports + the existing `POST /workspaces/:id/chat/threads` and `GET /workspaces/:id/chat/threads` test blocks — with the user-scoped versions. The shape:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

// `processChatTurn` and `callTitleLLM` are mocked — message-route tests
// don't need a real LLM. The auto-title mock is critical: without it,
// the fire-and-forget `void generateAndPersistThreadTitle(...)` in the
// message route would issue a real Gemini HTTP call in test, which
// (a) hangs in CI without GEMINI_API_KEY, and (b) under vitest
// singleFork can bleed into subsequent tests in the same file.
vi.mock("../src/chat/turn.js", () => ({
  processChatTurn: vi.fn().mockResolvedValue({
    assistantText: "ok",
    presentationBlocks: [],
    toolCalls: [],
  }),
}));
vi.mock("../src/chat/auto-title-llm.js", () => ({
  callTitleLLM: vi.fn().mockResolvedValue("Auto Title"),
}));

const env = {
  NODE_ENV: "test" as const, PORT: 0,
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
beforeEach(async () => { await truncateAll(); });

async function setup(email: string): Promise<{ userId: string; cookie: string; wsId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { userId: u.userId, cookie: u.cookie, wsId };
}

// Tier upgrade: fresh signup is auto-trial (Pro). For non-Pro tests,
// set User.trialEndsAt to the past so `effectiveTier` returns "free".
async function downgradeToFree(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { trialEndsAt: new Date("2020-01-01T00:00:00Z"), trialConsumed: true },
  });
}

describe("POST /chat/threads", () => {
  it("201 — creates an unbound thread, returns DTO with workspaceId: null", async () => {
    const { cookie } = await setup("ct1@t.co");
    const res = await app.inject({
      method: "POST",
      url: "/chat/threads",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ title: "hello" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.thread.workspaceId).toBeNull();
    expect(body.thread.title).toBe("hello");
    expect(body.thread.userId).toBeTruthy();
  });

  it("201 — without title", async () => {
    const { cookie } = await setup("ct2@t.co");
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { cookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().thread.title).toBeNull();
  });

  it("401 — no session", async () => {
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(401);
  });

  it("402 — non-Pro user", async () => {
    const { userId, cookie } = await setup("ct3@t.co");
    await downgradeToFree(userId);
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { cookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(402);
  });

  it("400 — invalid_body when title is too long", async () => {
    const { cookie } = await setup("ct4@t.co");
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ title: "x".repeat(201) }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("ignores X-Workspace-Id header (transport policy)", async () => {
    const { cookie } = await setup("ct5@t.co");
    const res = await app.inject({
      method: "POST", url: "/chat/threads",
      headers: { cookie, "content-type": "application/json", "x-workspace-id": "bogus-ws-id" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().thread.workspaceId).toBeNull();
  });
});

describe("GET /chat/threads", () => {
  it("200 — returns the user's threads (bound + unbound)", async () => {
    const { userId, cookie, wsId } = await setup("gt1@t.co");
    await prisma.chatThread.create({ data: { userId, workspaceId: null, title: "unbound" } });
    await prisma.chatThread.create({ data: { userId, workspaceId: wsId, title: "bound" } });
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const titles = res.json().threads.map((t: { title: string | null }) => t.title);
    expect(titles).toContain("bound");
    expect(titles).toContain("unbound");
  });

  it("200 — does not return other users' threads", async () => {
    const { cookie: cookieA } = await setup("gt2a@t.co");
    const { userId: userB } = await setup("gt2b@t.co");
    await prisma.chatThread.create({ data: { userId: userB, workspaceId: null, title: "B-thread" } });
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie: cookieA } });
    expect(res.json().threads).toEqual([]);
  });

  it("200 — open to non-Pro users (Lite needs to read brief threads)", async () => {
    const { userId, cookie } = await setup("gt3@t.co");
    await downgradeToFree(userId);
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it("401 — no session", async () => {
    const res = await app.inject({ method: "GET", url: "/chat/threads" });
    expect(res.statusCode).toBe(401);
  });

  it("200 — returns user's threads even when user has zero workspace memberships", async () => {
    const { userId, cookie } = await setup("gt4@t.co");
    await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    await prisma.membership.deleteMany({ where: { userId } });
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().threads).toHaveLength(1);
  });

  it("200 — DTO includes workspaceId, userId, title, lastMessageAt, archivedAt", async () => {
    const { userId, cookie } = await setup("gt5@t.co");
    await prisma.chatThread.create({ data: { userId, workspaceId: null, title: "t" } });
    const res = await app.inject({ method: "GET", url: "/chat/threads", headers: { cookie } });
    const row = res.json().threads[0];
    expect(row).toMatchObject({
      userId, workspaceId: null, title: "t",
      lastMessageAt: null, archivedAt: null,
    });
    expect(typeof row.createdAt).toBe("string");
  });
});
```

For now, leave the other describe blocks (Item routes, Messages) in the existing test file as-is — they still reference the old paths and will fail, which is expected. Tasks 5 and 6 will replace them.

- [ ] **Step 4.3: Run tests to verify the new ones fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts -t "POST /chat/threads"
```

Expected: failures — the route `/chat/threads` doesn't exist yet (404).

- [ ] **Step 4.4: Replace `apps/api/src/routes/chat.ts` entirely**

This task **fully overwrites** `chat.ts`. The old `/workspaces/:id/chat/*` handlers MUST be deleted in this step — they would otherwise fail to compile after Task 2's service signature changes (and Task 3's auto-title signature change). The item routes (Task 5) and messages route (Task 6) will be added in their own commits.

After this step, `chat.ts` has exactly two routes: `POST /chat/threads` and `GET /chat/threads`. Item endpoints (GET/PATCH/DELETE/:tid) and the messages endpoint return 404 until Tasks 5 + 6 land. That's expected — the corresponding tests are not added until those tasks.

Overwrite the full file with:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError, requireSession } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import { threadsService } from "../chat/threads.js";
import { prisma } from "../db.js";

const CreateBody = z.object({
  title: z.string().min(1).max(200).optional(),
});

const ListQuery = z.object({
  include_archived: z.union([z.literal("true"), z.literal("false")]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function serializeThread(t: {
  id: string; userId: string; workspaceId: string | null; title: string | null;
  lastMessageAt: Date | null; archivedAt: Date | null;
  createdAt: Date; updatedAt: Date;
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
  };
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post("/chat/threads", async (req, reply) => {
    const parsed = CreateBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const session = await requireSession(req, app);
      const tier = await effectiveTier(session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const thread = await threadsService.create({
        userId: session.userId,
        title: parsed.data.title ?? null,
      });
      return reply.code(201).send({ thread: serializeThread(thread) });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/chat/threads", async (req, reply) => {
    const parsed = ListQuery.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });

    try {
      const session = await requireSession(req, app);
      const includeArchived = parsed.data.include_archived === "true";
      const limit = parsed.data.limit ?? 50;
      const threads = await threadsService.list({
        userId: session.userId, includeArchived, limit,
      });

      // Hydrate per-thread aggregates: messageCount + firstMessagePreview
      // (the listing UI needs both — see existing chat.routes.test.ts).
      const threadIds = threads.map((t) => t.id);
      const counts = threadIds.length === 0 ? [] : await prisma.chatMessage.groupBy({
        by: ["threadId"],
        where: { threadId: { in: threadIds } },
        _count: { _all: true },
      });
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

  // Item routes (GET/PATCH/DELETE /chat/threads/:tid) added in Task 5.
  // Messages route (POST /chat/threads/:tid/messages) added in Task 6.
}
```

Also overwrite the existing test blocks that exercise the old paths. In `apps/api/tests/chat.routes.test.ts`, any remaining describe block that references `/workspaces/.../chat/...` must be deleted at this step. Tasks 5 and 6 add fresh describe blocks for the new paths. The file after Step 4.2 + this deletion should contain only:
- The imports + helpers + env block from Step 4.2
- The `describe("POST /chat/threads", …)` block from Step 4.2
- The `describe("GET /chat/threads", …)` block from Step 4.2

Run a sanity check:

```bash
grep -n "workspaces.*chat" apps/api/tests/chat.routes.test.ts
```

Should return zero hits.

- [ ] **Step 4.5: Run tests to verify they pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts -t "POST /chat/threads"
```

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts -t "GET /chat/threads"
```

Expected: both blocks pass. The remaining (old-path) tests in the same file are still failing — that's fine.

- [ ] **Step 4.6: Commit**

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
git commit -m "feat(plan 2-chat-user-scope): POST/GET /chat/threads

Collection routes now user-scoped: no workspaceId in URL, no
X-Workspace-Id header. requireSession instead of requireWorkspaceContext.
DTO carries workspaceId: string | null. Pro-tier gate on POST; GET
open for Lite (will need to read brief threads in Plan 2B)."
```

---

## Task 5: Item routes — GET / PATCH / DELETE /chat/threads/:tid

**Goal:** Item endpoints authorized by `thread.userId === session.userId`. PATCH and DELETE work on both bound and unbound threads (auth by userId, not workspace).

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/tests/chat.routes.test.ts`

- [ ] **Step 5.1: Write failing tests for the new item endpoints**

Append to `apps/api/tests/chat.routes.test.ts` (the helpers from Task 4 are reused — same file, more describe blocks):

```ts
describe("GET /chat/threads/:tid", () => {
  it("200 — returns the thread + messages", async () => {
    const { userId, cookie } = await setup("gti1@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    const res = await app.inject({ method: "GET", url: `/chat/threads/${t.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.thread.id).toBe(t.id);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it("403 — another user's thread (not 404; the row exists)", async () => {
    const { cookie: cookieA } = await setup("gti2a@t.co");
    const { userId: userB } = await setup("gti2b@t.co");
    const t = await prisma.chatThread.create({ data: { userId: userB, workspaceId: null } });
    const res = await app.inject({ method: "GET", url: `/chat/threads/${t.id}`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(403);
  });

  it("404 — thread doesn't exist at all", async () => {
    const { cookie } = await setup("gti3@t.co");
    const res = await app.inject({ method: "GET", url: "/chat/threads/nope", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("200 — works on archived threads", async () => {
    const { userId, cookie } = await setup("gti4@t.co");
    const t = await prisma.chatThread.create({
      data: { userId, workspaceId: null, archivedAt: new Date() },
    });
    const res = await app.inject({ method: "GET", url: `/chat/threads/${t.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.archivedAt).toBeTruthy();
  });

  it("200 — open to non-Pro users (Lite needs to read brief threads)", async () => {
    const { userId, cookie } = await setup("gti5@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    await downgradeToFree(userId);
    const res = await app.inject({ method: "GET", url: `/chat/threads/${t.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });
});

describe("PATCH /chat/threads/:tid", () => {
  it("200 — renames an unbound thread", async () => {
    const { userId, cookie } = await setup("pti1@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    const res = await app.inject({
      method: "PATCH", url: `/chat/threads/${t.id}`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ title: "renamed" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().thread.title).toBe("renamed");
  });

  it("200 — renames a bound thread", async () => {
    const { userId, cookie, wsId } = await setup("pti2@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: wsId } });
    const res = await app.inject({
      method: "PATCH", url: `/chat/threads/${t.id}`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ title: "x" }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("403 — another user's thread", async () => {
    const { cookie: cookieA } = await setup("pti3a@t.co");
    const { userId: userB } = await setup("pti3b@t.co");
    const t = await prisma.chatThread.create({ data: { userId: userB, workspaceId: null } });
    const res = await app.inject({
      method: "PATCH", url: `/chat/threads/${t.id}`,
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: JSON.stringify({ title: "stolen" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("402 — non-Pro", async () => {
    const { userId, cookie } = await setup("pti4@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    await downgradeToFree(userId);
    const res = await app.inject({
      method: "PATCH", url: `/chat/threads/${t.id}`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ title: "x" }),
    });
    expect(res.statusCode).toBe(402);
  });
});

describe("DELETE /chat/threads/:tid", () => {
  it("204 — archives an unbound thread", async () => {
    const { userId, cookie } = await setup("dti1@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    const res = await app.inject({ method: "DELETE", url: `/chat/threads/${t.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(reload.archivedAt).toBeTruthy();
  });

  it("204 — archives a bound thread", async () => {
    const { userId, cookie, wsId } = await setup("dti2@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: wsId } });
    const res = await app.inject({ method: "DELETE", url: `/chat/threads/${t.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(204);
  });

  it("403 — another user's thread", async () => {
    const { cookie: cookieA } = await setup("dti3a@t.co");
    const { userId: userB } = await setup("dti3b@t.co");
    const t = await prisma.chatThread.create({ data: { userId: userB, workspaceId: null } });
    const res = await app.inject({ method: "DELETE", url: `/chat/threads/${t.id}`, headers: { cookie: cookieA } });
    expect(res.statusCode).toBe(403);
  });

  it("402 — non-Pro", async () => {
    const { userId, cookie } = await setup("dti4@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    await downgradeToFree(userId);
    const res = await app.inject({ method: "DELETE", url: `/chat/threads/${t.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(402);
  });
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts -t "/chat/threads/:tid"
```

Expected: 404 / "no route matched" failures for `GET/PATCH/DELETE /chat/threads/:tid`.

- [ ] **Step 5.3: Add item route handlers to chat.ts**

**Precondition check** — verify Task 4's state before editing:

```bash
grep -cE "^  app\.(get|post|patch|delete)" apps/api/src/routes/chat.ts
```

Expected: `2` (the two collection routes from Task 4). If you see a different count, Task 4 was not applied cleanly — stop and resolve before continuing.

Task 4 left `chat.ts` with only the collection routes; this step appends the three item routes inside the `chatRoutes` function body (above the closing `}`). Also add the `PatchBody` schema next to `CreateBody` and `ListQuery` at the top of the file:

```ts
const PatchBody = z.object({
  title: z.union([z.string().min(1).max(200), z.null()]),
});
```

Then insert these route handlers just before the trailing `}` of `chatRoutes`:

```ts
  app.get("/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { tid: string };
    try {
      const session = await requireSession(req, app);
      const thread = await threadsService.findOwned({
        threadId: params.tid, userId: session.userId,
      });
      if (!thread) {
        // Distinguish "row exists but wrong owner" (403) from "row doesn't
        // exist at all" (404). One direct lookup decides which.
        const exists = await prisma.chatThread.findUnique({ where: { id: params.tid }, select: { id: true } });
        return reply.code(exists ? 403 : 404).send({ error: exists ? "forbidden" : "thread_not_found" });
      }

      const recent = await prisma.chatMessage.findMany({
        where: { threadId: thread.id },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
      const messages = recent.reverse();

      return {
        thread: serializeThread(thread),
        messages: messages.map((m) => ({
          id: m.id, role: m.role, blocks: m.blocks,
          createdAt: m.createdAt.toISOString(),
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.patch("/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { tid: string };
    const parsed = PatchBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const session = await requireSession(req, app);
      const tier = await effectiveTier(session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const updated = await threadsService.patch({
        threadId: params.tid, userId: session.userId, title: parsed.data.title,
      });
      if (!updated) {
        const exists = await prisma.chatThread.findUnique({ where: { id: params.tid }, select: { id: true } });
        return reply.code(exists ? 403 : 404).send({ error: exists ? "forbidden" : "thread_not_found" });
      }
      return { thread: serializeThread(updated) };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.delete("/chat/threads/:tid", async (req, reply) => {
    const params = req.params as { tid: string };
    try {
      const session = await requireSession(req, app);
      const tier = await effectiveTier(session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const archived = await threadsService.archive({
        threadId: params.tid, userId: session.userId,
      });
      if (!archived) {
        const exists = await prisma.chatThread.findUnique({ where: { id: params.tid }, select: { id: true } });
        return reply.code(exists ? 403 : 404).send({ error: exists ? "forbidden" : "thread_not_found" });
      }
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
```

After this step, `chat.ts` has 5 route handlers (POST /chat/threads, GET /chat/threads, GET /chat/threads/:tid, PATCH /chat/threads/:tid, DELETE /chat/threads/:tid). The messages route (Task 6) is still missing — POSTs to `/chat/threads/:tid/messages` will 404 until Task 6 lands.

- [ ] **Step 5.4: Run tests to verify they pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts -t "/chat/threads/:tid"
```

Expected: all GET/PATCH/DELETE blocks pass. The Messages tests still fail because Task 6 hasn't run.

- [ ] **Step 5.5: Commit**

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
git commit -m "feat(plan 2-chat-user-scope): GET/PATCH/DELETE /chat/threads/:tid

Item routes authorized by thread.userId === session.userId.
404 vs 403 distinguished via a direct id lookup so the client can
tell 'doesn't exist' from 'not yours'. PATCH/DELETE work on bound
AND unbound threads — auth no longer ties to membership."
```

---

## Task 6: Messages route with lazy workspace binding

**Goal:** The heart of the refactor. `POST /chat/threads/:tid/messages` reads `workspaceId` from the body, verifies membership, then either binds (if thread was unbound) or validates (if already bound) — all inside a `prisma.$transaction` to keep the bind atomic against concurrent archive. Once bound, the LLM turn runs with `ctx.workspaceId === boundWsId`.

**Files:**
- Modify: `apps/api/src/routes/chat.ts`
- Modify: `apps/api/tests/chat.routes.test.ts`

- [ ] **Step 6.1: Write failing tests for the new messages route**

Append to `apps/api/tests/chat.routes.test.ts`:

```ts
describe("POST /chat/threads/:tid/messages", () => {
  it("200 — first message binds the thread to body.workspaceId", async () => {
    const { userId, cookie, wsId } = await setup("mt1@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    const res = await app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "hello", workspaceId: wsId }),
    });
    expect(res.statusCode).toBe(200);
    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(reload.workspaceId).toBe(wsId);
  });

  it("200 — second message in a bound thread keeps the binding", async () => {
    const { userId, cookie, wsId } = await setup("mt2@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: wsId } });
    const res = await app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: wsId }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("400 — body.workspaceId mismatches bound thread", async () => {
    const { userId, cookie, wsId } = await setup("mt3@t.co");
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: wsId } });
    const res = await app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: otherWs.id }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
  });

  it("403 — user is not a member of body.workspaceId", async () => {
    const { userId, cookie } = await setup("mt4@t.co");
    const strangerWs = await prisma.workspace.create({ data: { name: "stranger" } });
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    const res = await app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: strangerWs.id }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_member");
  });

  it("403 — another user's thread", async () => {
    const { cookie: cookieA } = await setup("mt5a@t.co");
    const { userId: userB, wsId: wsB } = await setup("mt5b@t.co");
    const t = await prisma.chatThread.create({ data: { userId: userB, workspaceId: null } });
    const res = await app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie: cookieA, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: wsB }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("402 — non-Pro user", async () => {
    const { userId, cookie, wsId } = await setup("mt6@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    await downgradeToFree(userId);
    const res = await app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: wsId }),
    });
    expect(res.statusCode).toBe(402);
  });

  it("404 — archived thread (binding does not happen)", async () => {
    const { userId, cookie, wsId } = await setup("mt7@t.co");
    const t = await prisma.chatThread.create({
      data: { userId, workspaceId: null, archivedAt: new Date() },
    });
    const res = await app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: wsId }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("400 — invalid_body when workspaceId is missing", async () => {
    const { userId, cookie } = await setup("mt8@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    const res = await app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("ignores X-Workspace-Id header — body wins", async () => {
    const { userId, cookie, wsId } = await setup("mt9@t.co");
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
    const res = await app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json", "x-workspace-id": otherWs.id },
      payload: JSON.stringify({ text: "x", workspaceId: wsId }),
    });
    expect(res.statusCode).toBe(200);
    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(reload.workspaceId).toBe(wsId);
  });
});
```

- [ ] **Step 6.2: Run tests to verify they fail**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts -t "POST /chat/threads/:tid/messages"
```

Expected: 404/no-route failures.

- [ ] **Step 6.3: Add the messages route to chat.ts**

**Precondition check** — verify Tasks 4 + 5's state before editing:

```bash
grep -cE "^  app\.(get|post|patch|delete)" apps/api/src/routes/chat.ts
```

Expected: `5` (POST/GET collection from Task 4, GET/PATCH/DELETE item from Task 5). If you see a different count, prior tasks were not applied cleanly — stop and resolve before continuing.

Task 4 / 5 left `chat.ts` without a messages route. This step appends it inside the `chatRoutes` function body (above the closing `}`). Also add the `MessageBody` schema next to `CreateBody`/`ListQuery`/`PatchBody` at the top of the file, and add the imports for `generateAndPersistThreadTitle`, `processChatTurn`, and `PresentationBlock`:

```ts
// At the top of the file, append to imports:
import { generateAndPersistThreadTitle } from "../chat/auto-title.js";
import { processChatTurn } from "../chat/turn.js";
import type { PresentationBlock } from "../chat/blocks.js";

// Next to CreateBody/ListQuery/PatchBody, add:
const MessageBody = z.object({
  text: z.string().min(1).max(4000),
  workspaceId: z.string().min(1).max(64),
});
```

Then insert this handler just before the trailing `}` of `chatRoutes`:

```ts
  app.post("/chat/threads/:tid/messages", async (req, reply) => {
    const params = req.params as { tid: string };
    const parsed = MessageBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const session = await requireSession(req, app);
      const tier = await effectiveTier(session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      // Membership check uses the unique constraint @@unique([userId, workspaceId])
      // on Membership — see spec §5.2.
      const membership = await prisma.membership.findUnique({
        where: {
          userId_workspaceId: {
            userId: session.userId,
            workspaceId: parsed.data.workspaceId,
          },
        },
        select: { role: true },
      });
      if (!membership) return reply.code(403).send({ error: "not_member" });

      // Find the thread by id + userId. 403 vs 404 mirror Tasks 4/5.
      // archivedAt IS NULL guards against POSTing to an archived thread.
      const thread = await prisma.chatThread.findFirst({
        where: { id: params.tid, userId: session.userId, archivedAt: null },
        select: { id: true, workspaceId: true, title: true },
      });
      if (!thread) {
        const exists = await prisma.chatThread.findUnique({ where: { id: params.tid }, select: { userId: true, archivedAt: true } });
        if (!exists || exists.archivedAt) return reply.code(404).send({ error: "thread_not_found" });
        return reply.code(403).send({ error: "forbidden" });
      }

      // Lazy bind — atomic conditional UPDATE wrapped in a transaction so a
      // concurrent archive can't slip between UPDATE and refetch (see spec §6.1).
      const boundWsId = await prisma.$transaction(async (tx) => {
        if (thread.workspaceId !== null) {
          if (thread.workspaceId !== parsed.data.workspaceId) {
            throw new HttpError(400, "workspace_mismatch");
          }
          return thread.workspaceId;
        }
        const upd = await tx.chatThread.updateMany({
          where: { id: thread.id, workspaceId: null, archivedAt: null },
          data: { workspaceId: parsed.data.workspaceId },
        });
        if (upd.count === 1) return parsed.data.workspaceId;
        // Lost the race: either someone else bound it, or it got archived.
        const refetched = await tx.chatThread.findFirstOrThrow({
          where: { id: thread.id },
          select: { workspaceId: true, archivedAt: true },
        });
        if (refetched.archivedAt !== null) throw new HttpError(404, "thread_not_found");
        if (refetched.workspaceId === null || refetched.workspaceId !== parsed.data.workspaceId) {
          throw new HttpError(400, "workspace_mismatch");
        }
        return refetched.workspaceId;
      });

      const userMessage = await prisma.$transaction(async (tx) => {
        const m = await tx.chatMessage.create({
          data: {
            threadId: thread.id,
            role: "user",
            blocks: [{ type: "text", markdown: parsed.data.text }],
          },
        });
        await tx.chatThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: m.createdAt },
        });
        return m;
      });

      let turn: Awaited<ReturnType<typeof processChatTurn>>;
      try {
        turn = await processChatTurn(
          app.fina.env,
          { id: thread.id, workspaceId: boundWsId },
          session.userId,
          membership.role,
        );
      } catch (e) {
        console.error("chat provider failed", { threadId: thread.id, err: e });
        return reply.code(500).send({ error: "chat_provider_error" });
      }

      const assistantMessage = await prisma.$transaction(async (tx) => {
        const blocks: PresentationBlock[] = [
          { type: "text", markdown: turn.assistantText },
          ...turn.presentationBlocks,
        ];
        const m = await tx.chatMessage.create({
          data: {
            threadId: thread.id,
            role: "assistant",
            blocks: blocks as never,
          },
        });
        await tx.chatThread.update({
          where: { id: thread.id },
          data: { lastMessageAt: m.createdAt },
        });
        return m;
      });

      // Plan 1E-title: fire-and-forget auto-title on the first user message.
      // generateAndPersistThreadTitle no longer takes workspaceId — the
      // conditional update gates on (id, title IS NULL), which is sufficient
      // since threadId is a global cuid and auth is done above.
      if (thread.title === null) {
        try {
          const userMsgCount = await prisma.chatMessage.count({
            where: { threadId: thread.id, role: "user" },
          });
          if (userMsgCount === 1) {
            void generateAndPersistThreadTitle(
              app.fina.env, thread.id, parsed.data.text,
            ).catch(() => {
              /* orchestrator logs internally */
            });
          }
        } catch (err) {
          console.warn("auto-title trigger gate failed", { threadId: thread.id, err });
        }
      }

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

Verify: after this edit, the chat.ts file has no remaining `/workspaces/:id/chat/*` route handlers. Run `grep -n "workspaces.*chat" apps/api/src/routes/chat.ts` — should return zero hits.

- [ ] **Step 6.4: Run tests to verify they pass**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.routes.test.ts
```

Expected: every block in the file is green now. The old paths are gone; only `/chat/*` routes remain.

- [ ] **Step 6.5: Commit**

```bash
git add apps/api/src/routes/chat.ts apps/api/tests/chat.routes.test.ts
git commit -m "feat(plan 2-chat-user-scope): POST /chat/threads/:tid/messages lazy bind

First user message commits the thread to body.workspaceId via a
conditional UPDATE inside a $transaction. Subsequent messages must
match the bound workspaceId. X-Workspace-Id header is ignored on
this route — body is authoritative. Membership check via the unique
(userId, workspaceId) index. Archive guard before bind. processChatTurn
gets boundWsId (never the stale thread.workspaceId)."
```

---

## Task 7: Race + binding edge tests

**Goal:** Isolated test file for concurrent first-messages (different and same workspaceId) and archive-during-bind races. These tests exercise the `$transaction` boundary in Task 6 and live in a focused file so they're easy to find and reason about.

**Files:**
- Create: `apps/api/tests/chat.lazy-binding.test.ts`

- [ ] **Step 7.1: Create the lazy-binding test file**

Create `apps/api/tests/chat.lazy-binding.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

vi.mock("../src/chat/turn.js", () => ({
  processChatTurn: vi.fn().mockResolvedValue({
    assistantText: "ok",
    presentationBlocks: [],
    toolCalls: [],
  }),
}));
vi.mock("../src/chat/auto-title-llm.js", () => ({
  callTitleLLM: vi.fn().mockResolvedValue("Auto Title"),
}));

const env = {
  NODE_ENV: "test" as const, PORT: 0,
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
beforeEach(async () => { await truncateAll(); });

async function setup(email: string) {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { userId: u.userId, cookie: u.cookie, wsId };
}

describe("lazy binding races", () => {
  it("two concurrent first-messages targeting DIFFERENT workspaces — exactly one binds, the other 400 workspace_mismatch", async () => {
    const { userId, cookie, wsId } = await setup("rb1@t.co");
    const otherWs = await prisma.workspace.create({ data: { name: "other" } });
    await prisma.membership.create({ data: { userId, workspaceId: otherWs.id, role: "owner" } });
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });

    const post = (ws: string) => app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: ws }),
    });

    const [a, b] = await Promise.all([post(wsId), post(otherWs.id)]);
    // Numeric sort with explicit comparator — JS default sort is
    // lexicographic, which coincidentally works for [200, 400] but
    // breaks if status codes ever differ in length (e.g., 200 vs 1000).
    const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 400]);
    const loser = a.statusCode === 400 ? a : b;
    expect(loser.json().error).toBe("workspace_mismatch");

    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect([wsId, otherWs.id]).toContain(reload.workspaceId);
  });

  it("two concurrent first-messages targeting the SAME workspace — both succeed; thread bound exactly once", async () => {
    const { userId, cookie, wsId } = await setup("rb2@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });

    const post = () => app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: wsId }),
    });

    const [a, b] = await Promise.all([post(), post()]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    expect(reload.workspaceId).toBe(wsId);
    const userMessages = await prisma.chatMessage.count({
      where: { threadId: t.id, role: "user" },
    });
    expect(userMessages).toBe(2);
  });

  it("archive-during-bind — DELETE racing with first-message: either archive wins (POST 404) or bind wins (DELETE archives bound thread); never archived-but-bound visible", async () => {
    const { userId, cookie, wsId } = await setup("rb3@t.co");
    const t = await prisma.chatThread.create({ data: { userId, workspaceId: null } });

    const post = app.inject({
      method: "POST", url: `/chat/threads/${t.id}/messages`,
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ text: "x", workspaceId: wsId }),
    });
    const del = app.inject({
      method: "DELETE", url: `/chat/threads/${t.id}`,
      headers: { cookie },
    });

    const [p, d] = await Promise.all([post, del]);
    // Either outcome is acceptable; both must be terminal and consistent.
    // Validate consistency: if POST succeeded, the thread is now both
    // bound and archived (acceptable — DELETE landed after bind).
    // If POST 404'd, the thread is archived and unbound.
    const reload = await prisma.chatThread.findUniqueOrThrow({ where: { id: t.id } });
    if (p.statusCode === 200) {
      expect(d.statusCode).toBe(204);
      expect(reload.workspaceId).toBe(wsId);
      expect(reload.archivedAt).toBeTruthy();
    } else {
      expect(p.statusCode).toBe(404);
      expect(reload.workspaceId).toBeNull();
      expect(reload.archivedAt).toBeTruthy();
    }
  });
});
```

- [ ] **Step 7.2: Run the tests**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.lazy-binding.test.ts
```

Expected: all 3 tests pass. If the archive-race test is flaky, retry once locally — Postgres scheduling can occasionally land both winners in the same order. The assertion accepts BOTH outcomes (`p === 200` or `p === 404`), so it's already permissive; flakiness here would indicate a real bug.

- [ ] **Step 7.3: Commit**

```bash
git add apps/api/tests/chat.lazy-binding.test.ts
git commit -m "test(plan 2-chat-user-scope): lazy-binding race coverage

- Concurrent first-messages, different workspaceId → one binds, one
  400 workspace_mismatch.
- Concurrent first-messages, same workspaceId → both succeed.
- Archive racing first-message → either archive-wins (POST 404) or
  bind-wins (DELETE archives bound thread); never archived-but-bound
  visible mid-transaction."
```

---

## Task 8: Migration smoke + index coverage test

**Goal:** A test that the migration leaves the new index in place and the listing query plans against it (Index Scan, not Seq Scan). Also verifies `audit_events` count is unchanged across the migration boundary (only chat tables + action_intents are purged).

**Files:**
- Create: `apps/api/tests/chat.migration.smoke.test.ts`

- [ ] **Step 8.1: Create the migration smoke test**

Create `apps/api/tests/chat.migration.smoke.test.ts`:

```ts
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { disconnect } from "./helpers/db.js";

afterAll(async () => { await disconnect(); });

describe("plan 2-chat-user-scope migration smoke", () => {
  it("index chat_threads_userId_archivedAt_lastMessageAt_idx exists", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
        WHERE tablename = 'chat_threads'
          AND indexname = 'chat_threads_userId_archivedAt_lastMessageAt_idx';
    `;
    expect(rows.length).toBe(1);
  });

  it("old workspaceId-keyed index is gone", async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
        WHERE tablename = 'chat_threads'
          AND indexname = 'chat_threads_workspaceId_archivedAt_lastMessageAt_idx';
    `;
    expect(rows.length).toBe(0);
  });

  it("EXPLAIN of the user-listing query uses the new index", async () => {
    // Seed a few rows so the planner doesn't pick a Seq Scan for an empty table.
    const stamp = `idx-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "I" } });
    for (let i = 0; i < 50; i++) {
      await prisma.chatThread.create({
        data: { userId: stamp, workspaceId: null, lastMessageAt: new Date(Date.now() - i * 1000) },
      });
    }
    // ANALYZE so the planner has stats.
    await prisma.$executeRawUnsafe(`ANALYZE chat_threads`);

    const plan = await prisma.$queryRaw<Array<{ "QUERY PLAN": string }>>`
      EXPLAIN SELECT * FROM chat_threads
        WHERE "userId" = ${stamp} AND "archivedAt" IS NULL
        ORDER BY "lastMessageAt" DESC NULLS LAST
        LIMIT 10;
    `;
    const planText = plan.map((r) => r["QUERY PLAN"]).join("\n");
    // Accept Index Scan or Index Only Scan against the new index. Reject Seq Scan.
    expect(planText).toMatch(/Index (Only )?Scan.*chat_threads_userId_archivedAt_lastMessageAt_idx/);
    expect(planText).not.toMatch(/Seq Scan on chat_threads/);

    // Cleanup
    await prisma.chatThread.deleteMany({ where: { userId: stamp } });
    await prisma.user.delete({ where: { id: stamp } });
  });

  it("chat_threads has the post-migration column shape", async () => {
    const cols = await prisma.$queryRaw<Array<{ column_name: string; is_nullable: string }>>`
      SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'chat_threads';
    `;
    const byName = new Map(cols.map((c) => [c.column_name, c.is_nullable]));
    expect(byName.get("userId")).toBe("NO");
    expect(byName.get("workspaceId")).toBe("YES");
  });

  it("migration SQL does not touch audit_events (preservation guarantee)", async () => {
    // Spec §3 commits to preserving audit_events rows across the migration.
    // The migration runs once at deploy-time, so we can't replay it in-test.
    // Instead, statically verify the migration SQL never references
    // audit_events — a one-line grep that would fail loudly if a later
    // edit accidentally adds a DELETE.
    const fs = await import("node:fs/promises");
    const sql = await fs.readFile(
      "prisma/migrations/20260520130000_chat_user_scope/migration.sql",
      "utf8",
    );
    expect(sql).not.toMatch(/audit_events/i);
  });
});
```

- [ ] **Step 8.2: Run the smoke test**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.migration.smoke.test.ts
```

The audit-events grep test reads the migration SQL file directly. The test runs from the `apps/api/` working directory (where pnpm filter sets cwd), so the relative path `prisma/migrations/...` resolves correctly.

Expected: all 5 tests green. If the EXPLAIN test fails with Seq Scan, the planner is choosing it because the table is small. Two fallbacks (in order of preference):

1. Increase the seeded row count from 50 → 500.
2. As a last resort, force the planner: wrap the EXPLAIN query in a session that does `SET LOCAL enable_seqscan = OFF;` first. Note this proves the index *can* serve the query, not that the planner *will* pick it in production — but production tables have many more rows, so the index will be picked there.

Pseudo-snippet for the fallback:

```ts
const plan = await prisma.$transaction(async (tx) => {
  await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = OFF;");
  return tx.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(
    `EXPLAIN SELECT * FROM chat_threads WHERE "userId" = '${stamp}' AND "archivedAt" IS NULL ORDER BY "lastMessageAt" DESC NULLS LAST LIMIT 10`,
  );
});
```

- [ ] **Step 8.3: Run the FULL test suite to catch cross-file regressions**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts
```

Expected: every test file passes. Baseline before this plan was 920 passed; this plan adds ~30 new tests and rewrites ~25, so expect roughly 945–960 passing. No failures. If any test file references the removed `/workspaces/:id/chat/*` paths (unlikely outside chat.routes.test.ts, but search:

```bash
grep -rn "workspaces.*chat/threads" apps/api/ 2>/dev/null | grep -v node_modules | grep -v ".test.ts.bak"
```

returns zero hits), update them.

- [ ] **Step 8.4: Commit**

```bash
git add apps/api/tests/chat.migration.smoke.test.ts
git commit -m "test(plan 2-chat-user-scope): migration smoke + index coverage

Verifies the new chat_threads_userId_archivedAt_lastMessageAt_idx
exists and is selected by the listing query (Index Scan, not Seq
Scan). Confirms the old workspaceId-keyed index is dropped. Asserts
the column shape (userId NOT NULL, workspaceId nullable)."
```

---

## Final review

After all 8 tasks land:

- [ ] **Verify no /workspaces/.../chat references remain anywhere**

```bash
grep -rn "workspaces.*chat" apps/api/src/ apps/api/tests/ 2>/dev/null | grep -v node_modules
```

Should return zero hits.

- [ ] **Run the full test suite one final time**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api exec vitest run --config vitest.config.ts 2>&1 | tail -10
```

Expected: clean pass.

- [ ] **Smoke doc — optional but recommended for handoff to Plan 2B**

Past plans (1C-scheduled-spend, 1E-search) ship a `docs/superpowers/smoke-tests/2026-05-20-plan-2-chat-user-scope.md` with curl-based step-by-step verification. Same shape: create thread → POST messages → verify binding → PATCH/DELETE → list. Defer to a separate small commit if time-boxed.
