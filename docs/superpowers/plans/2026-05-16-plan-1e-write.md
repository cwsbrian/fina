# Plan 1E-write Implementation Plan: Chat Write Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 13th and 14th chat tools (`createCategory`, `addTransactionNote`), extract a shared `createCategoryService` so the existing HTTP route + new chat tool share validation/cap/duplicate rules, propagate caller `role` into `ToolContext` so `createCategory` can enforce owner-only access.

**Architecture:** A thin chat tool calls a shared service. `ToolContext` grows a `role` field that the chat turn populates from the route's `requireWorkspaceContext` membership. The existing `POST /workspaces/:id/categories` HTTP route is refactored to delegate to the service while keeping its `duplicate_name` wire error code intact. `addTransactionNote` is a thin Prisma update + workspace-scope check, no shared service needed.

**Tech Stack:** TypeScript ESM, Zod, Prisma (with `P2002` mapping for the partial unique index `categories_one_active_name_per_workspace_ci`), Vitest, Postgres on port 5433.

**Spec:** `docs/superpowers/specs/2026-05-16-plan-1e-write-design.md`

---

## File Structure

**Created:**
- `apps/api/src/categories/create.ts` — shared `createCategoryService` (trim, 30-cap, duplicate, parent resolution, P2002 mapping). ~80 lines.
- `apps/api/src/chat/tools/create-category.ts` — chat tool wrapper. ~60 lines.
- `apps/api/src/chat/tools/add-transaction-note.ts` — chat tool. ~60 lines.
- `apps/api/tests/categories.create-service.test.ts` — service unit tests (~6 cases).
- `apps/api/tests/chat.tools.create-category.test.ts` — chat tool tests (~11 cases).
- `apps/api/tests/chat.tools.add-transaction-note.test.ts` — chat tool tests (~8 cases).

**Modified:**
- `apps/api/src/chat/tools/types.ts` — extend `ToolContext` with `role: Role`.
- `apps/api/src/chat/turn.ts` — accept `role` parameter on `processChatTurn`, propagate to `toolCtx`, append confirmation paragraph to `SYSTEM_PROMPT`.
- `apps/api/src/routes/chat.ts` — pass `ctx.membership.role` to `processChatTurn` (one call site).
- `apps/api/src/routes/categories.ts` — POST route delegates to `createCategoryService`, translates `category_exists` → `duplicate_name`. Route tests remain green.
- `apps/api/src/chat/tools/index.ts` — add 13th + 14th `REGISTRY` entries.
- `apps/api/tests/chat.tools.registry.test.ts` — add `plan 1e-write` describe block.

**Untouched:**
- The 12 other chat tool files and their tests.
- Schema (no migration).
- The existing `apps/api/tests/categories.routes.test.ts` (verify it stays green after route refactor — Step 1.5).

---

## Shared Conventions (apply to every task)

1. **ESM imports.** Every relative import ends in `.js`.
2. **Prisma.** `prisma` from `"../db.js"` for service code, `"../../db.js"` for chat tools. Type-only `Prisma` from `"@prisma/client"`.
3. **Role type.** `Role` from `"@fina/shared"` (already used by `apps/api/src/auth/membership.ts`).
4. **ToolContext.** After Task 2, all tools receive `ctx.role`. Existing tools don't use it; only `createCategory` reads it.
5. **Service error codes.** `createCategoryService` throws plain `new Error("snake_case_code")`: `parent_not_found`, `too_many_categories`, `category_exists`. Callers translate as needed.
6. **HTTP route compatibility.** `POST /workspaces/:id/categories` keeps emitting `duplicate_name` (existing public code), not `category_exists`. The translation happens in the route handler.
7. **Test framework.** Vitest. `prisma` imported from `"../src/db.js"` in tests. ctx shape: `{ env: {} as never, workspaceId, userId, role }`.
8. **Commands.**
   - Single test: `pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/<file>.test.ts`
   - Full suite: `pnpm nx run api:test` (the Nx target; `pnpm --filter @fina/api test` is a no-op because `apps/api/package.json` has no `test` script)
   - Typecheck: `pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json`
9. **Pre-existing typecheck baseline.** `apps/api/src/chat/turn.ts:127` has one inherited `InputJsonValue` error from plan 1E-chat. Out of scope.

---

## Task 1: Extract `createCategoryService`

**Goal:** Move the category creation logic out of the HTTP route into a reusable service. HTTP route delegates to it. Behavior preserved (same validation, cap, duplicate handling, error codes on the wire).

**Files:**
- Create: `apps/api/src/categories/create.ts`
- Create: `apps/api/tests/categories.create-service.test.ts`
- Modify: `apps/api/src/routes/categories.ts` (POST handler — delegate to service)

### Step 1.1: Write the failing test

Create `apps/api/tests/categories.create-service.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createCategoryService } from "../src/categories/create.js";

describe("createCategoryService", () => {
  let wsId: string;
  let otherWsId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `cc-${Date.now()}`, email: `cc-${Date.now()}@t.co`, name: "CC" } });
    const ws = await prisma.workspace.create({ data: { name: "cc-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    const ws2 = await prisma.workspace.create({ data: { name: "other-cc-ws" } });
    otherWsId = ws2.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: [wsId, otherWsId] } } });
  });

  it("creates a top-level category", async () => {
    const r = await createCategoryService({ workspaceId: wsId, name: "Food" });
    expect(r.id).toMatch(/^[a-z0-9]+$/);
    expect(r.name).toBe("Food");
    expect(r.parentId).toBeNull();
  });

  it("creates a child with a parent id", async () => {
    const parent = await createCategoryService({ workspaceId: wsId, name: "Food" });
    const child = await createCategoryService({ workspaceId: wsId, name: "Coffee", parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  it("throws category_exists for duplicate active name (case-insensitive)", async () => {
    await createCategoryService({ workspaceId: wsId, name: "Food" });
    await expect(createCategoryService({ workspaceId: wsId, name: "food" })).rejects.toThrow("category_exists");
  });

  it("allows reusing the name of an archived sibling", async () => {
    const first = await createCategoryService({ workspaceId: wsId, name: "Food" });
    await prisma.category.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
    const r = await createCategoryService({ workspaceId: wsId, name: "Food" });
    expect(r.id).not.toBe(first.id);
  });

  it("throws too_many_categories at the 30-active cap", async () => {
    for (let i = 0; i < 30; i++) {
      await createCategoryService({ workspaceId: wsId, name: `Cat${i}` });
    }
    await expect(createCategoryService({ workspaceId: wsId, name: "Overflow" })).rejects.toThrow("too_many_categories");
  });

  it("isolates by workspace (same name OK across workspaces)", async () => {
    await createCategoryService({ workspaceId: wsId, name: "Food" });
    const r = await createCategoryService({ workspaceId: otherWsId, name: "Food" });
    expect(r.id).toMatch(/^[a-z0-9]+$/);
  });

  it("rejects parentId from another workspace → throws parent_not_found", async () => {
    const otherParent = await createCategoryService({ workspaceId: otherWsId, name: "OtherParent" });
    await expect(
      createCategoryService({ workspaceId: wsId, name: "Child", parentId: otherParent.id }),
    ).rejects.toThrow("parent_not_found");
  });

  it("rejects archived parentId → throws parent_not_found", async () => {
    const parent = await createCategoryService({ workspaceId: wsId, name: "ArchivedParent" });
    await prisma.category.update({ where: { id: parent.id }, data: { archivedAt: new Date() } });
    await expect(
      createCategoryService({ workspaceId: wsId, name: "Child", parentId: parent.id }),
    ).rejects.toThrow("parent_not_found");
  });
});
```

### Step 1.2: Run test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/categories.create-service.test.ts
```
Expected: FAIL with `Cannot find module '../src/categories/create.js'`.

### Step 1.3: Implement the service

Create `apps/api/src/categories/create.ts`:

```typescript
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

export const MAX_NAME_LEN = 40;
export const MAX_ACTIVE_CATEGORIES = 30;

export type CreateCategoryInput = {
  workspaceId: string;
  name: string;
  parentId?: string | null;
};

export type CreateCategoryOutput = {
  id: string;
  name: string;
  parentId: string | null;
};

/**
 * Create an active category in a workspace. Shared by:
 * - POST /workspaces/:id/categories (HTTP route)
 * - createCategory chat tool
 *
 * Throws `new Error("too_many_categories")` if the workspace already has 30
 * active categories. Throws `new Error("category_exists")` for a case-insensitive
 * active-name duplicate (both via the pre-check AND via P2002 from the partial
 * unique index `categories_one_active_name_per_workspace_ci`, to catch races).
 * Throws `new Error("parent_not_found")` if `parentId` is given but doesn't
 * refer to an active category in the SAME workspace (defense-in-depth: chat
 * tool already pre-validates parent_name, but any future caller passing a raw
 * parentId still gets the same invariant).
 *
 * The service does NOT trim or validate `name`; callers (HTTP Zod schema +
 * chat-tool Zod schema) trim and length-check before invoking.
 */
export async function createCategoryService(
  input: CreateCategoryInput,
): Promise<CreateCategoryOutput> {
  if (input.parentId != null) {
    const parent = await prisma.category.findFirst({
      where: { id: input.parentId, workspaceId: input.workspaceId, archivedAt: null },
      select: { id: true },
    });
    if (!parent) throw new Error("parent_not_found");
  }

  const activeCount = await prisma.category.count({
    where: { workspaceId: input.workspaceId, archivedAt: null },
  });
  if (activeCount >= MAX_ACTIVE_CATEGORIES) {
    throw new Error("too_many_categories");
  }

  const dup = await prisma.category.findFirst({
    where: {
      workspaceId: input.workspaceId,
      archivedAt: null,
      name: { equals: input.name, mode: "insensitive" },
    },
    select: { id: true },
  });
  if (dup) throw new Error("category_exists");

  try {
    const created = await prisma.category.create({
      data: {
        workspaceId: input.workspaceId,
        name: input.name,
        parentId: input.parentId ?? null,
      },
      select: { id: true, name: true, parentId: true },
    });
    return { id: created.id, name: created.name, parentId: created.parentId };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      // Race against the partial unique index.
      throw new Error("category_exists");
    }
    throw e;
  }
}
```

### Step 1.4: Run service test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/categories.create-service.test.ts
```
Expected: 8/8 PASS.

### Step 1.5: Refactor the HTTP route to use the service

In `apps/api/src/routes/categories.ts`, replace the POST handler body. The handler still:
- Requires `owner` role (unchanged).
- Trims + Zod validates (unchanged).
- Returns 422 with `too_many_categories` / `duplicate_name` for the cap / duplicate cases.

Find the existing POST handler at lines 39–81 and replace its inner try-catch body with the service-delegating version below. The Zod parse, the auth check, the workspace-mismatch check, and the wrapping `try { ... } catch (e) { if (e instanceof HttpError) ... }` block stay in place.

Replace the body between `const wsId = ctx.membership.workspaceId;` and the closing `}` of the outer try-catch with:

```typescript
      const wsId = ctx.membership.workspaceId;
      const nameTrim = parsed.data.name.trim();

      try {
        const created = await createCategoryService({ workspaceId: wsId, name: nameTrim });
        return reply.code(201).send({ category: { id: created.id, name: created.name, icon: null, color: null } });
      } catch (svcErr) {
        if (svcErr instanceof Error) {
          if (svcErr.message === "too_many_categories") {
            return reply.code(422).send({ error: "too_many_categories" });
          }
          if (svcErr.message === "category_exists") {
            return reply.code(422).send({ error: "duplicate_name" });
          }
        }
        throw svcErr;
      }
```

Add the service import at the top of the file:

```typescript
import { createCategoryService } from "../categories/create.js";
```

The old inline count-check, duplicate-check, and `prisma.category.create` calls are removed. The `MAX_NAME_LEN` / `MAX_ACTIVE_CATEGORIES` constants in this file stay (the Zod schema still uses `MAX_NAME_LEN`); they're now ALSO exported from the service file as the source of truth, but local duplicates in the route file are harmless and the route's Zod still references the local copy.

### Step 1.6: Run the existing route tests + service tests to verify nothing regressed

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts \
  tests/categories.routes.test.ts \
  tests/categories.create-service.test.ts
```
Expected: all route tests still green (existing wire codes preserved), service tests 8/8 PASS.

### Step 1.7: Commit

```bash
git add apps/api/src/categories/create.ts \
        apps/api/src/routes/categories.ts \
        apps/api/tests/categories.create-service.test.ts
git commit -m "refactor(categories): extract createCategoryService; preserve POST duplicate_name wire code"
```

---

## Task 2: Extend `ToolContext` with `role`

**Goal:** Thread the caller's workspace role from the chat route through `processChatTurn` into `ToolContext`, so tools can run targeted role checks without re-querying the DB.

**Files:**
- Modify: `apps/api/src/chat/tools/types.ts`
- Modify: `apps/api/src/chat/turn.ts`
- Modify: `apps/api/src/routes/chat.ts`

### Step 2.1: Extend the type

Replace `apps/api/src/chat/tools/types.ts` with:

```typescript
import type { z } from "zod";
import type { Role } from "@fina/shared";
import type { Env } from "../../env.js";

export type ToolContext = {
  env: Env;
  workspaceId: string;
  userId: string;
  role: Role;
};

export type ToolDef<TArgs = unknown, TResult = unknown> = {
  name: string;
  description: string;
  args: z.ZodType<TArgs>;
  run: (ctx: ToolContext, args: TArgs) => Promise<TResult>;
};
```

### Step 2.2: Update `processChatTurn` to accept and propagate `role`

In `apps/api/src/chat/turn.ts`:

1. Find the existing signature (line 75-ish):

   ```typescript
   export async function processChatTurn(
     env: Env,
     thread: { id: string; workspaceId: string },
     userId: string,
   ): Promise<{ assistantText: string; toolCalls: ToolCallRecord[] }> {
   ```

2. Add a `role` parameter and import `Role`:

   - At the top of the file with the other imports, add:
     ```typescript
     import type { Role } from "@fina/shared";
     ```

   - Change the signature to:
     ```typescript
     export async function processChatTurn(
       env: Env,
       thread: { id: string; workspaceId: string },
       userId: string,
       role: Role,
     ): Promise<{ assistantText: string; toolCalls: ToolCallRecord[] }> {
     ```

3. Update the `toolCtx` construction (was around line 85):

   - From:
     ```typescript
     const toolCtx: ToolContext = { env, workspaceId: thread.workspaceId, userId };
     ```
   - To:
     ```typescript
     const toolCtx: ToolContext = { env, workspaceId: thread.workspaceId, userId, role };
     ```

### Step 2.3: Update the chat route to pass `role`

In `apps/api/src/routes/chat.ts` find the existing call site (around line 235):

```typescript
turn = await processChatTurn(app.fina.env, { id: thread.id, workspaceId: thread.workspaceId }, ctx.session.userId);
```

Replace with:

```typescript
turn = await processChatTurn(app.fina.env, { id: thread.id, workspaceId: thread.workspaceId }, ctx.session.userId, ctx.membership.role);
```

`ctx.membership.role` is already populated by `requireWorkspaceContext` (returns `AssertedMembership` which has `role: Role`).

### Step 2.4: Update existing turn tests to pass `role`

In `apps/api/tests/chat.turn.test.ts`, the existing tests call `processChatTurn(env, ...)` without a role argument. Find each call (search for `processChatTurn(` in that file) and add `"owner"` as the 4th argument. Example:

- Before: `await processChatTurn(env, { id: threadId, workspaceId: wsId }, userId)`
- After: `await processChatTurn(env, { id: threadId, workspaceId: wsId }, userId, "owner")`

There are roughly 9 call sites in `chat.turn.test.ts`; update every one.

### Step 2.5: Run the full suite + typecheck to confirm propagation is clean

Run:
```bash
pnpm nx run api:test
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json
```
Expected: all tests still green. Typecheck only shows the one pre-existing `turn.ts:127` error.

### Step 2.6: Commit

```bash
git add apps/api/src/chat/tools/types.ts \
        apps/api/src/chat/turn.ts \
        apps/api/src/routes/chat.ts \
        apps/api/tests/chat.turn.test.ts
git commit -m "feat(plan 1e-write): thread caller role into ToolContext"
```

---

## Task 3: `createCategory` chat tool

**Files:**
- Create: `apps/api/src/chat/tools/create-category.ts`
- Create: `apps/api/tests/chat.tools.create-category.test.ts`

### Step 3.1: Write the failing test

Create `apps/api/tests/chat.tools.create-category.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createCategory } from "../src/chat/tools/create-category.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("createCategory chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let userId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `cct-${Date.now()}`, email: `cct-${Date.now()}@t.co`, name: "CCT" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "cct-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("owner creates a top-level category", async () => {
    const r = await createCategory.run(ctx, { name: "Food" });
    expect(r.category.id).toMatch(/^[a-z0-9]+$/);
    expect(r.category.name).toBe("Food");
    expect(r.category.parentId).toBeNull();
    expect(r.category.parentName).toBeNull();
  });

  it("owner creates a child under existing active parent (case-insensitive)", async () => {
    const parent = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    const r = await createCategory.run(ctx, { name: "Coffee", parent_name: "food" });
    expect(r.category.parentId).toBe(parent.id);
    expect(r.category.parentName).toBe("Food"); // canonical, not the user input "food"
  });

  it("parent_name not found in workspace → throws parent_not_found", async () => {
    await expect(createCategory.run(ctx, { name: "Coffee", parent_name: "Nope" })).rejects.toThrow("parent_not_found");
  });

  it("duplicate active name (case-insensitive) → throws category_exists", async () => {
    await createCategory.run(ctx, { name: "Food" });
    await expect(createCategory.run(ctx, { name: "food" })).rejects.toThrow("category_exists");
  });

  it("archived sibling with same name → creates a new active row", async () => {
    const first = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    await prisma.category.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
    const r = await createCategory.run(ctx, { name: "Food" });
    expect(r.category.id).not.toBe(first.id);
  });

  it("parent_name in another workspace → throws parent_not_found", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    await prisma.category.create({ data: { workspaceId: other.id, name: "Food" } });
    await expect(createCategory.run(ctx, { name: "Coffee", parent_name: "Food" })).rejects.toThrow("parent_not_found");
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("workspace isolation: row is in caller's workspace, not visible elsewhere", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    await createCategory.run(ctx, { name: "Food" });
    const others = await prisma.category.findMany({ where: { workspaceId: other.id } });
    expect(others).toHaveLength(0);
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("editor caller → throws insufficient_role", async () => {
    const editorCtx: ToolContext = { ...ctx, role: "editor" };
    await expect(createCategory.run(editorCtx, { name: "Food" })).rejects.toThrow("insufficient_role");
  });

  it("at the 30-category cap → throws too_many_categories", async () => {
    for (let i = 0; i < 30; i++) {
      await prisma.category.create({ data: { workspaceId: wsId, name: `Cat${i}` } });
    }
    await expect(createCategory.run(ctx, { name: "Overflow" })).rejects.toThrow("too_many_categories");
  });

  it("Zod: whitespace-only name → fails parsing", async () => {
    // run() receives already-parsed args from dispatchTool; the Zod schema
    // is what enforces .trim().min(1). Test the schema directly.
    const parsed = createCategory.args.safeParse({ name: "   " });
    expect(parsed.success).toBe(false);
  });

  it("Zod: name longer than 40 chars (post-trim) → fails parsing", async () => {
    const parsed = createCategory.args.safeParse({ name: "x".repeat(41) });
    expect(parsed.success).toBe(false);
  });
});
```

### Step 3.2: Run test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.create-category.test.ts
```
Expected: FAIL with `Cannot find module '../src/chat/tools/create-category.js'`.

### Step 3.3: Implement the tool

Create `apps/api/src/chat/tools/create-category.ts`:

```typescript
import { z } from "zod";
import { prisma } from "../../db.js";
import { createCategoryService } from "../../categories/create.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe(
      "Category name. Trimmed of surrounding whitespace; uniqueness check is case-insensitive against existing active categories.",
    ),
  parent_name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .describe(
      "Optional parent category name (case-insensitive exact match against active categories). Omit for a top-level category.",
    )
    .optional(),
});

type Args = z.infer<typeof Args>;

type Result = {
  category: {
    id: string;
    name: string;
    parentId: string | null;
    parentName: string | null;
  };
};

export const createCategory: ToolDef<Args, Result> = {
  name: "createCategory",
  description:
    "Create a new active category in the current workspace. Optional parent category by name. " +
    "Throws category_exists if an active category with this name already exists.",
  args: Args,
  async run(ctx, args) {
    if (ctx.role !== "owner") {
      throw new Error("insufficient_role");
    }

    let parentId: string | null = null;
    let parentName: string | null = null;
    if (args.parent_name) {
      const parent = await prisma.category.findFirst({
        where: {
          workspaceId: ctx.workspaceId,
          archivedAt: null,
          name: { equals: args.parent_name, mode: "insensitive" },
        },
        select: { id: true, name: true },
      });
      if (!parent) throw new Error("parent_not_found");
      parentId = parent.id;
      parentName = parent.name;
    }

    const created = await createCategoryService({
      workspaceId: ctx.workspaceId,
      name: args.name,
      parentId,
    });

    return {
      category: {
        id: created.id,
        name: created.name,
        parentId: created.parentId,
        parentName,
      },
    };
  },
};
```

### Step 3.4: Run test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.create-category.test.ts
```
Expected: all 11 tests PASS.

### Step 3.5: Commit

```bash
git add apps/api/src/chat/tools/create-category.ts \
        apps/api/tests/chat.tools.create-category.test.ts
git commit -m "feat(plan 1e-write): createCategory chat tool (owner-only, delegates to createCategoryService)"
```

---

## Task 4: `addTransactionNote` chat tool

**Files:**
- Create: `apps/api/src/chat/tools/add-transaction-note.ts`
- Create: `apps/api/tests/chat.tools.add-transaction-note.test.ts`

### Step 4.1: Write the failing test

Create `apps/api/tests/chat.tools.add-transaction-note.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { addTransactionNote } from "../src/chat/tools/add-transaction-note.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("addTransactionNote chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let acctId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `atn-${Date.now()}`, email: `atn-${Date.now()}@t.co`, name: "ATN" } });
    const ws = await prisma.workspace.create({ data: { name: "atn-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "editor" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "editor" };

    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    acctId = acct.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function seedTx(id: string, extra: { note?: string | null; removedAt?: Date | null } = {}) {
    return prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acctId,
        plaidTransactionId: `pt-${id}`,
        amount: "5.00",
        merchantRaw: "Test",
        occurredAt: new Date(),
        rawData: {},
        note: extra.note ?? null,
        removedAt: extra.removedAt ?? null,
      },
      select: { id: true },
    }).then((r) => r.id);
  }

  it("sets a note on an active transaction", async () => {
    const txId = await seedTx("1");
    const r = await addTransactionNote.run(ctx, { tx_id: txId, note: "paid by John" });
    expect(r.tx.note).toBe("paid by John");
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: txId }, select: { note: true } });
    expect(row.note).toBe("paid by John");
  });

  it("replaces (does NOT append to) an existing note", async () => {
    const txId = await seedTx("2", { note: "old text" });
    const r = await addTransactionNote.run(ctx, { tx_id: txId, note: "new text" });
    expect(r.tx.note).toBe("new text");
  });

  it("note: null clears the note", async () => {
    const txId = await seedTx("3", { note: "to be cleared" });
    const r = await addTransactionNote.run(ctx, { tx_id: txId, note: null });
    expect(r.tx.note).toBeNull();
  });

  it("works on soft-deleted transactions (notes are historical metadata)", async () => {
    const txId = await seedTx("4", { removedAt: new Date() });
    const r = await addTransactionNote.run(ctx, { tx_id: txId, note: "history" });
    expect(r.tx.note).toBe("history");
  });

  it("unknown tx_id → throws transaction_not_found", async () => {
    await expect(addTransactionNote.run(ctx, { tx_id: "does-not-exist", note: "x" })).rejects.toThrow("transaction_not_found");
  });

  it("cross-workspace tx_id → throws transaction_not_found", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const otherAcct = await prisma.bankAccount.create({ data: { workspaceId: other.id, name: "x", type: "depository" } });
    const otherTx = await prisma.transaction.create({
      data: {
        workspaceId: other.id,
        accountId: otherAcct.id,
        plaidTransactionId: "p-other",
        amount: "1.00",
        merchantRaw: "x",
        occurredAt: new Date(),
        rawData: {},
      },
      select: { id: true },
    });
    await expect(addTransactionNote.run(ctx, { tx_id: otherTx.id, note: "x" })).rejects.toThrow("transaction_not_found");
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("Zod: empty string note → fails parsing", async () => {
    // run() receives already-parsed args from dispatchTool. Test the schema directly.
    const parsed = addTransactionNote.args.safeParse({ tx_id: "any", note: "" });
    expect(parsed.success).toBe(false);
  });

  it("Zod: note longer than 1000 chars → fails parsing", async () => {
    const parsed = addTransactionNote.args.safeParse({ tx_id: "any", note: "x".repeat(1001) });
    expect(parsed.success).toBe(false);
  });
});
```

### Step 4.2: Run test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.add-transaction-note.test.ts
```
Expected: FAIL with `Cannot find module '../src/chat/tools/add-transaction-note.js'`.

### Step 4.3: Implement the tool

Create `apps/api/src/chat/tools/add-transaction-note.ts`:

```typescript
import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  tx_id: z
    .string()
    .min(1)
    .describe("Transaction id. Must belong to the current workspace."),
  note: z
    .union([z.string().min(1).max(1000), z.null()])
    .describe(
      "New note text (1-1000 chars), or null to clear. REPLACES any existing note. To append, the LLM should first read the existing note via getTransactionDetails and submit the combined text.",
    ),
});

type Args = z.infer<typeof Args>;

type Result = {
  tx: {
    id: string;
    note: string | null;
    updatedAt: string;
  };
};

export const addTransactionNote: ToolDef<Args, Result> = {
  name: "addTransactionNote",
  description:
    "Set or clear the note on one transaction. Replaces the existing note entirely (pass null to clear).",
  args: Args,
  async run(ctx, args) {
    const existing = await prisma.transaction.findFirst({
      where: { id: args.tx_id, workspaceId: ctx.workspaceId },
      select: { id: true },
    });
    if (!existing) throw new Error("transaction_not_found");

    const updated = await prisma.transaction.update({
      where: { id: existing.id },
      data: { note: args.note },
      select: { id: true, note: true, updatedAt: true },
    });

    return {
      tx: {
        id: updated.id,
        note: updated.note,
        updatedAt: updated.updatedAt.toISOString(),
      },
    };
  },
};
```

### Step 4.4: Run test to verify it passes

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.add-transaction-note.test.ts
```
Expected: all 8 tests PASS.

### Step 4.5: Commit

```bash
git add apps/api/src/chat/tools/add-transaction-note.ts \
        apps/api/tests/chat.tools.add-transaction-note.test.ts
git commit -m "feat(plan 1e-write): addTransactionNote chat tool (replace semantics, null clears)"
```

---

## Task 5: Register tools + system prompt update + schema regression

**Files:**
- Modify: `apps/api/src/chat/tools/index.ts`
- Modify: `apps/api/src/chat/turn.ts` (append to `SYSTEM_PROMPT`)
- Modify: `apps/api/tests/chat.tools.registry.test.ts`

### Step 5.1: Write the failing registry test

Append the following `describe` block to the end of `apps/api/tests/chat.tools.registry.test.ts`:

```typescript
describe("REGISTRY (plan 1e-write)", () => {
  const EXPECTED = [
    [
      "createCategory",
      "Create a new active category in the current workspace. Optional parent category by name. " +
        "Throws category_exists if an active category with this name already exists.",
    ],
    [
      "addTransactionNote",
      "Set or clear the note on one transaction. Replaces the existing note entirely (pass null to clear).",
    ],
  ] as const;

  it("contains both new tool names", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description strings from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("has .describe() on every top-level arg field", () => {
    for (const [name] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool).toBeDefined();
      const shape = (tool!.args as z.ZodObject<z.ZodRawShape>).shape;
      for (const [field, schema] of Object.entries(shape)) {
        const desc = (schema as z.ZodTypeAny).description;
        expect(desc, `${name}.${field} missing description`).toBeTruthy();
      }
    }
  });

  it("Gemini declarations emit parametersJsonSchema for both tools", () => {
    const decls = toGeminiFunctionDeclarations(REGISTRY);
    for (const [name] of EXPECTED) {
      const decl = decls.find((d) => d.name === name);
      expect(decl, `missing declaration for ${name}`).toBeDefined();
      expect(decl!.parametersJsonSchema).toBeDefined();
    }
  });
});
```

### Step 5.2: Run registry test to verify it fails

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.registry.test.ts
```
Expected: 4 NEW `plan 1e-write` tests FAIL because the tools are not yet registered. Existing 8 tests in `plan 1e-next` and `plan 1e-search` blocks still PASS.

### Step 5.3: Register the new tools

Edit `apps/api/src/chat/tools/index.ts` to its final state:

```typescript
import type { ToolDef } from "./types.js";
import { listTransactions } from "./list-transactions.js";
import { getSpendingSummary } from "./get-spending-summary.js";
import { listCategories } from "./list-categories.js";
import { categorizeTransaction } from "./categorize-transaction.js";
import { listAccounts } from "./list-accounts.js";
import { getTransactionDetails } from "./get-transaction-details.js";
import { findUncategorizedTransactions } from "./find-uncategorized-transactions.js";
import { getCategoryBreakdown } from "./get-category-breakdown.js";
import { compareSpendingPeriods } from "./compare-spending-periods.js";
import { detectRecurringMerchants } from "./detect-recurring-merchants.js";
import { getCashflowSummary } from "./get-cashflow-summary.js";
import { findTransactions } from "./find-transactions.js";
import { createCategory } from "./create-category.js";
import { addTransactionNote } from "./add-transaction-note.js";

export const REGISTRY: ToolDef[] = [
  listTransactions as ToolDef,
  getSpendingSummary as ToolDef,
  listCategories as ToolDef,
  categorizeTransaction as ToolDef,
  listAccounts as ToolDef,
  getTransactionDetails as ToolDef,
  findUncategorizedTransactions as ToolDef,
  getCategoryBreakdown as ToolDef,
  compareSpendingPeriods as ToolDef,
  detectRecurringMerchants as ToolDef,
  getCashflowSummary as ToolDef,
  findTransactions as ToolDef,
  createCategory as ToolDef,
  addTransactionNote as ToolDef,
];
```

### Step 5.4: Append the confirmation paragraph to `SYSTEM_PROMPT`

In `apps/api/src/chat/turn.ts` find the `SYSTEM_PROMPT` constant and replace it with:

```typescript
const SYSTEM_PROMPT = `You are Fina, a personal-finance assistant for Canadian users. You help users
understand their spending, categorize transactions, and plan their budgets.

Style:
- Concise. Short sentences. No bullet lists unless asked.
- Use Korean if the user writes in Korean; otherwise English.
- Currency is CAD unless stated.

When you need data, call a tool. Don't make up transactions, balances, or categories.
When a tool returns { error: ... }, briefly explain the issue and suggest what to try.

Don't ask permission to look up data — just call the tool and show the result.

For write tools (createCategory, addTransactionNote), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?'`;
```

The only change is the final paragraph being appended.

### Step 5.5: Run registry + full suite + typecheck

Run:
```bash
pnpm --filter @fina/api exec vitest run --config vitest.config.ts tests/chat.tools.registry.test.ts
pnpm nx run api:test
pnpm --filter @fina/api exec tsc --noEmit -p tsconfig.app.json
```

Expected:
- Registry: 12/12 PASS (4 plan-1e-next + 4 plan-1e-search + 4 plan-1e-write).
- Full suite: all green.
- Typecheck: only the one pre-existing error on `apps/api/src/chat/turn.ts:127`.

### Step 5.6: Commit

```bash
git add apps/api/src/chat/tools/index.ts \
        apps/api/src/chat/turn.ts \
        apps/api/tests/chat.tools.registry.test.ts
git commit -m "feat(plan 1e-write): register createCategory + addTransactionNote; system prompt confirms before write"
```

---

## Acceptance Verification

After Task 5, walk through the spec's §9 acceptance criteria:

- `createCategory` and `addTransactionNote` registered as the 13th and 14th entries in `REGISTRY` (Step 5.3).
- Exact description strings from spec §5.1 and §6.1 (Step 5.1 test enforces).
- All args have `.describe()` text (Step 5.1 test enforces).
- `createCategory` is owner-only — throws `insufficient_role` for non-owners (Task 3 test).
- `createCategory` trims and caps `name` at 40 chars (Task 3 Zod tests).
- `createCategory` enforces the 30-active cap (Task 3 test + Task 1 service test).
- `createCategory` resolves `parent_name` case-insensitively against active categories (Task 3 test).
- `createCategory` returns the canonical `parentName` from the stored row, not user input (Task 3 test).
- `createCategory` throws `category_exists` on duplicates; allows archived-sibling reuse (Tasks 1 + 3 tests).
- `addTransactionNote` replaces (not appends); `null` clears; soft-deleted rows allowed (Task 4 tests).
- Both tools enforce `workspaceId: ctx.workspaceId` (Tasks 3 + 4 isolation tests).
- Cross-workspace ids return the same `_not_found` codes as in-workspace misses (Tasks 3 + 4 tests).
- Tier gate inherited; `addTransactionNote` trusts the chat route's editor gate; `createCategory` adds its own owner check (Task 3 editor-rejection test).
- Shared `createCategoryService` is used by BOTH the chat tool and the existing POST route; route's existing tests still pass (Step 1.6 + Task 3).
- System prompt has the new confirmation paragraph (Step 5.4).
- `ToolContext.role` is populated by the chat route (Task 2).
- 14 expected tools in registry (Step 5.5 full suite).

---

## Excluded scope (from spec §10)

These are NOT in this plan and should be REJECTED if a reviewer asks for them:

- `archiveCategory`, `renameCategory`, `setCategoryParent` — UI handles them.
- `archiveTransaction` / hard-delete — Plaid is source of truth.
- Budget / Goal / Schedule features — separate future plans (no data model yet).
- Color/icon args on `createCategory` — UI concern.
- Tool-level two-phase confirm — design rejected; system-prompt rule covers it.
- Bulk operations.
- Audit log columns.
