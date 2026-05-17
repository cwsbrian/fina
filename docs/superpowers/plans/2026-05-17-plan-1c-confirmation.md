# Plan 1C-confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 2-phase commit safety net for LLM-driven mutations. New `ActionIntent` Prisma model + `/intents/:id/consume` HTTP route + `presentConfirmCard` chat tool emitting a `confirm_card` block. Existing 6 write tools keep direct-execution; LLM decides per system prompt whether to wrap a mutate in a confirm card.

**Architecture:** Master design §11.1 confirmation flow. `presentConfirmCard` validates `accept_action.tool` against a whitelist + pre-validates `accept_action.args` against the target tool's Zod schema, creates an `ActionIntent` row (1-hour TTL), and returns a `confirm_card` block carrying only the intent ID. Client POSTs the ID back to consume; server atomically marks consumed, re-validates payload, and dispatches the tool. Raw `ToolCall` never appears on the client → server path.

**Tech Stack:** TypeScript ESM monorepo, Fastify, Prisma + Postgres on 5433, Vitest (singleFork).

**Spec:** [`docs/superpowers/specs/2026-05-17-plan-1c-confirmation-design.md`](../specs/2026-05-17-plan-1c-confirmation-design.md)

**Worktree:** This plan should be implemented in an isolated worktree branched from main. The subagent-driven-development skill will set this up via `EnterWorktree`.

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/prisma/schema.prisma` | Add `ActionIntent` model + relations on `Workspace`/`User` |
| `apps/api/prisma/migrations/<ts>_add_action_intents/migration.sql` | DDL: table + index + FKs |
| `apps/api/src/intents/service.ts` | `CONFIRMABLE_TOOLS`, `createIntentService`, `consumeIntentService` |
| `apps/api/src/chat/blocks.ts` | Shared `Block` discriminated-union type |
| `apps/api/src/chat/tools/present-confirm-card.ts` | `presentConfirmCard` chat tool |
| `apps/api/src/chat/tools/index.ts` | Register `presentConfirmCard` (21 → 22) |
| `apps/api/src/chat/turn.ts` | Collect `presentationBlocks` from tool results; SYSTEM_PROMPT update |
| `apps/api/src/routes/chat.ts` | Append `presentationBlocks` to assistant `chat_messages.blocks` |
| `apps/api/src/routes/intents.ts` | `/intents/:id/consume` route |
| `apps/api/src/server.ts` | Register `intentsRoutes` |
| `apps/api/tests/chat.tools.registry.test.ts` | Bump 21 → 22 (3 assertions) + plan-1c-confirmation describe block |
| `apps/api/tests/intents.service.test.ts` | ~10 service cases |
| `apps/api/tests/intents.routes.test.ts` | ~7 route cases (incl. workspace_mismatch + insufficient_role) |
| `apps/api/tests/chat.tools.present-confirm-card.test.ts` | ~5 chat-tool cases |
| `apps/api/tests/chat.turn.presentation-blocks.test.ts` | ~2 turn-handler cases |

No new dependencies.

---

## Pre-flight Sanity Check

From the worktree root:

```bash
docker ps --filter name=fina-postgres-dev --format "{{.Names}}: {{.Status}}"
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy
pnpm --filter @fina/api exec prisma generate
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** `fina-postgres-dev: Up …`. Both `db:deploy` "No pending migrations". Test suite: `77 passed / 635 passed`.

If not at baseline, stop and report.

---

## Task 1: Prisma model + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<ts>_add_action_intents/migration.sql`

### 1.1 Add the Prisma model

- [ ] **Step 1: Edit `apps/api/prisma/schema.prisma`**

Append the new model (place after `RecurringExpense` for readability):

```prisma
model ActionIntent {
  id          String    @id @default(cuid())
  workspaceId String
  userId      String
  messageId   String?
  kind        String
  payload     Json
  expiresAt   DateTime
  consumedAt  DateTime?
  createdAt   DateTime  @default(now())

  workspace Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  user      User      @relation(fields: [userId],      references: [id], onDelete: Cascade)

  @@index([workspaceId, userId, expiresAt])
  @@map("action_intents")
}
```

Add inverse relations:
- In `model Workspace { ... }`: `actionIntents ActionIntent[]`
- In `model User { ... }`: `actionIntents ActionIntent[]`

### 1.2 Generate the migration

- [ ] **Step 2: Generate migration skeleton**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
  pnpm --filter @fina/api exec prisma migrate dev --create-only --name add_action_intents 2>&1 | tail -20
```

Read the generated `migration.sql`. It should contain:
- `CREATE TABLE "action_intents"` with the 9 columns
- `CREATE INDEX "action_intents_workspaceId_userId_expiresAt_idx" ON "action_intents"(…)`
- 2 FK constraints (workspace → CASCADE, user → CASCADE)

If Prisma's `--create-only` includes an unrelated `DROP INDEX` stub (this has happened on prior plans for a manually-managed NULLS LAST index), STRIP IT OUT before applying.

### 1.3 Apply + verify baseline

- [ ] **Step 3: Apply on both DBs + regenerate client**

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina      pnpm --filter @fina/api db:deploy 2>&1 | tail -5
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina_test pnpm --filter @fina/api db:deploy 2>&1 | tail -5
pnpm --filter @fina/api exec prisma generate 2>&1 | tail -2
```

- [ ] **Step 4: Run the full suite**

```bash
pnpm nx run api:test --skipNxCache 2>&1 | tail -5
```

**Expected:** 77 files / 635 tests still PASS.

### 1.4 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/
git commit -m "feat(plan 1c-confirmation): ActionIntent model + migration"
```

---

## Task 2: Shared Block type + intents service (TDD)

**Files:**
- Create: `apps/api/src/chat/blocks.ts`
- Create: `apps/api/src/intents/service.ts`
- Create: `apps/api/tests/intents.service.test.ts`

### 2.1 Shared Block type

- [ ] **Step 1: Create `apps/api/src/chat/blocks.ts`**

```typescript
export type TextBlock = { type: "text"; markdown: string };

export type ConfirmCardBlock = {
  type: "confirm_card";
  question: string;
  acceptLabel: string;
  rejectLabel: string;
  acceptIntent: string;
  expiresAt: string;
};

export type Block = TextBlock | ConfirmCardBlock;
```

### 2.2 Failing tests for createIntentService

- [ ] **Step 2: Create `apps/api/tests/intents.service.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  createIntentService,
  consumeIntentService,
  CONFIRMABLE_TOOLS,
} from "../src/intents/service.js";

describe("createIntentService", () => {
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `ic-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "IC", tz: "America/Toronto" },
    });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "ic-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("creates a row with expiresAt ≈ now + 1 hour", async () => {
    const before = Date.now();
    const r = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Coffee" } },
    );
    const row = await prisma.actionIntent.findUnique({ where: { id: r.intent.id } });
    expect(row).not.toBeNull();
    expect(row?.consumedAt).toBeNull();
    const delta = row!.expiresAt.getTime() - before;
    // Expect ~3600000ms (1h), allow 5 second jitter for slow CI.
    expect(delta).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(delta).toBeLessThanOrEqual(3_600_000 + 5_000);
  });

  it("rejects a tool not in CONFIRMABLE_TOOLS → invalid_tool", async () => {
    await expect(
      createIntentService(
        { workspaceId, userId },
        { tool: "listTransactions", args: { period: "this_month" } },
      ),
    ).rejects.toThrow("invalid_tool");
  });

  it("rejects args failing target tool's Zod schema → invalid_payload_args", async () => {
    await expect(
      createIntentService(
        { workspaceId, userId },
        { tool: "createCategory", args: { name: "" } },
      ),
    ).rejects.toThrow("invalid_payload_args");
  });
});
```

- [ ] **Step 3: Run — expect FAIL (module missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/intents.service.test.ts --reporter=basic 2>&1 | tail -10
```

### 2.3 Implement createIntentService

- [ ] **Step 4: Create `apps/api/src/intents/service.ts`**

```typescript
import { Prisma } from "@prisma/client";
import type { Role } from "@fina/shared";
import { prisma } from "../db.js";
import { REGISTRY } from "../chat/tools/index.js";
import type { Env } from "../env.js";

export const CONFIRMABLE_TOOLS = [
  "createCategory",
  "addTransactionNote",
  "setBudget",
  "mapMerchantToCategory",
  "addRecurring",
  "removeRecurring",
] as const;
export type ConfirmableTool = (typeof CONFIRMABLE_TOOLS)[number];

function isConfirmable(t: string): t is ConfirmableTool {
  return (CONFIRMABLE_TOOLS as readonly string[]).includes(t);
}

const INTENT_TTL_MS = 60 * 60 * 1000;

export type IntentPayload = { tool: string; args: Record<string, unknown> };

export type CreateIntentInput = {
  tool: string;
  args: Record<string, unknown>;
  messageId?: string;
};

export type CreateIntentOutput = { intent: { id: string; expiresAt: string } };

export async function createIntentService(
  ctx: { workspaceId: string; userId: string },
  input: CreateIntentInput,
): Promise<CreateIntentOutput> {
  if (!isConfirmable(input.tool)) throw new Error("invalid_tool");
  const tool = REGISTRY.find((t) => t.name === input.tool);
  if (!tool) throw new Error("invalid_tool");
  const parsed = tool.args.safeParse(input.args);
  if (!parsed.success) throw new Error("invalid_payload_args");
  const expiresAt = new Date(Date.now() + INTENT_TTL_MS);
  // exactOptionalPropertyTypes: build data without messageId when undefined
  const data: Prisma.ActionIntentUncheckedCreateInput = {
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    kind: "tool_call",
    payload: { tool: input.tool, args: input.args } as Prisma.InputJsonValue,
    expiresAt,
  };
  if (input.messageId !== undefined) data.messageId = input.messageId;
  const row = await prisma.actionIntent.create({ data });
  return { intent: { id: row.id, expiresAt: row.expiresAt.toISOString() } };
}
```

- [ ] **Step 5: Run — expect PASS (3/3 so far)**

```bash
pnpm --filter @fina/api exec vitest run tests/intents.service.test.ts --reporter=basic 2>&1 | tail -10
```

### 2.4 Failing tests for consumeIntentService

- [ ] **Step 6: Append to `apps/api/tests/intents.service.test.ts`**

```typescript
describe("consumeIntentService", () => {
  let workspaceId: string;
  let userId: string;
  let env: { GEMINI_API_KEY: string; CHAT_MODEL: string };

  beforeEach(async () => {
    const stamp = `iv-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "IV", tz: "America/Toronto" },
    });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "iv-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    env = { GEMINI_API_KEY: "test-key", CHAT_MODEL: "gemini-2.5-flash-lite" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("happy path: dispatches createCategory, returns result, marks consumed", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Coffee" } },
    );
    const r = await consumeIntentService(
      { workspaceId, userId, role: "owner", env: env as never },
      intent.id,
    );
    expect(r.result).toMatchObject({ category: { name: "Coffee" } });
    const row = await prisma.actionIntent.findUnique({ where: { id: intent.id } });
    expect(row?.consumedAt).not.toBeNull();
  });

  it("intent_not_found for nonexistent id", async () => {
    await expect(
      consumeIntentService(
        { workspaceId, userId, role: "owner", env: env as never },
        "does-not-exist",
      ),
    ).rejects.toThrow("intent_not_found");
  });

  it("intent_owner_mismatch on cross-workspace", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "X" } },
    );
    await expect(
      consumeIntentService(
        { workspaceId: "other-ws", userId, role: "owner", env: env as never },
        intent.id,
      ),
    ).rejects.toThrow("intent_owner_mismatch");
  });

  it("intent_owner_mismatch when different user in same workspace", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "X" } },
    );
    await expect(
      consumeIntentService(
        { workspaceId, userId: "another-user", role: "owner", env: env as never },
        intent.id,
      ),
    ).rejects.toThrow("intent_owner_mismatch");
  });

  it("intent_gone for already-consumed", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Once" } },
    );
    await consumeIntentService(
      { workspaceId, userId, role: "owner", env: env as never },
      intent.id,
    );
    await expect(
      consumeIntentService(
        { workspaceId, userId, role: "owner", env: env as never },
        intent.id,
      ),
    ).rejects.toThrow("intent_gone");
  });

  it("intent_gone for expired", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Expired" } },
    );
    // Force expiry to the past.
    await prisma.actionIntent.update({
      where: { id: intent.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      consumeIntentService(
        { workspaceId, userId, role: "owner", env: env as never },
        intent.id,
      ),
    ).rejects.toThrow("intent_gone");
  });

  it("race-safe: two concurrent consumes — exactly one wins", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Race" } },
    );
    const results = await Promise.allSettled([
      consumeIntentService({ workspaceId, userId, role: "owner", env: env as never }, intent.id),
      consumeIntentService({ workspaceId, userId, role: "owner", env: env as never }, intent.id),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe("intent_gone");
  });
});
```

- [ ] **Step 7: Run — expect FAIL on consumeIntentService cases**

```bash
pnpm --filter @fina/api exec vitest run tests/intents.service.test.ts --reporter=basic 2>&1 | tail -10
```

### 2.5 Implement consumeIntentService

- [ ] **Step 8: Append to `apps/api/src/intents/service.ts`**

```typescript
export async function consumeIntentService(
  ctx: { workspaceId: string; userId: string; role: Role; env: Env },
  intentId: string,
): Promise<{ result: unknown }> {
  const row = await prisma.actionIntent.findUnique({ where: { id: intentId } });
  if (!row) throw new Error("intent_not_found");
  if (row.workspaceId !== ctx.workspaceId || row.userId !== ctx.userId) {
    throw new Error("intent_owner_mismatch");
  }
  if (row.consumedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    throw new Error("intent_gone");
  }
  // Atomic mark: only one concurrent consume wins.
  const updated = await prisma.actionIntent.updateMany({
    where: { id: intentId, consumedAt: null, expiresAt: { gt: new Date() } },
    data: { consumedAt: new Date() },
  });
  if (updated.count === 0) throw new Error("intent_gone");

  const payload = row.payload as IntentPayload;
  if (!isConfirmable(payload.tool)) throw new Error("invalid_tool");
  const tool = REGISTRY.find((t) => t.name === payload.tool);
  if (!tool) throw new Error("invalid_tool");
  const parsed = tool.args.safeParse(payload.args);
  if (!parsed.success) throw new Error("invalid_payload_args");

  const result = await tool.run(
    {
      env: ctx.env,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      role: ctx.role,
    },
    parsed.data,
  );
  return { result };
}
```

- [ ] **Step 9: Run — expect PASS (10/10)**

```bash
pnpm --filter @fina/api exec vitest run tests/intents.service.test.ts --reporter=basic 2>&1 | tail -10
```

### 2.6 Commit

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/chat/blocks.ts apps/api/src/intents/service.ts apps/api/tests/intents.service.test.ts
git commit -m "feat(plan 1c-confirmation): intents service + Block type"
```

---

## Task 3: presentConfirmCard chat tool (TDD)

**Files:**
- Create: `apps/api/src/chat/tools/present-confirm-card.ts`
- Create: `apps/api/tests/chat.tools.present-confirm-card.test.ts`

### 3.1 Failing tests

- [ ] **Step 1: Create `apps/api/tests/chat.tools.present-confirm-card.test.ts`**

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { presentConfirmCard } from "../src/chat/tools/present-confirm-card.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("presentConfirmCard chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `pcc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "PCC", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "pcc-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("Zod accepts valid args", () => {
    const r = presentConfirmCard.args.safeParse({
      question: "Make a Coffee category?",
      accept_action: { tool: "createCategory", args: { name: "Coffee" } },
    });
    expect(r.success).toBe(true);
  });

  it("Zod rejects missing accept_action", () => {
    const r = presentConfirmCard.args.safeParse({
      question: "Confirm?",
    });
    expect(r.success).toBe(false);
  });

  it("run creates an intent row matching the action; returns acceptIntent = intent id", async () => {
    const out = await presentConfirmCard.run(ctx, {
      question: "Make a Coffee category?",
      accept_action: { tool: "createCategory", args: { name: "Coffee" } },
    });
    expect(out.block.type).toBe("confirm_card");
    expect(out.block.acceptIntent).toBeTruthy();
    const row = await prisma.actionIntent.findUnique({ where: { id: out.block.acceptIntent } });
    expect(row).not.toBeNull();
    expect((row?.payload as { tool: string }).tool).toBe("createCategory");
    expect((row?.payload as { args: { name: string } }).args.name).toBe("Coffee");
  });

  it("block.expiresAt ≈ now + 1 hour", async () => {
    const before = Date.now();
    const out = await presentConfirmCard.run(ctx, {
      question: "Q",
      accept_action: { tool: "createCategory", args: { name: "X" } },
    });
    const ms = new Date(out.block.expiresAt).getTime();
    expect(ms - before).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(ms - before).toBeLessThanOrEqual(3_600_000 + 5_000);
  });

  it("propagates invalid_payload_args when args fail target tool's Zod", async () => {
    await expect(
      presentConfirmCard.run(ctx, {
        question: "Q",
        accept_action: { tool: "createCategory", args: { name: "" } },
      }),
    ).rejects.toThrow("invalid_payload_args");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.present-confirm-card.test.ts --reporter=basic 2>&1 | tail -10
```

### 3.2 Implement

- [ ] **Step 3: Create `apps/api/src/chat/tools/present-confirm-card.ts`**

```typescript
import { z } from "zod";
import { createIntentService } from "../../intents/service.js";
import type { ConfirmCardBlock } from "../blocks.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  question: z.string().min(1).max(500),
  accept_label: z.string().min(1).max(40).optional(),
  reject_label: z.string().min(1).max(40).optional(),
  accept_action: z.object({
    tool: z.string().min(1),
    args: z.record(z.unknown()),
  }),
});

type Args = z.infer<typeof Args>;

export const presentConfirmCard: ToolDef<Args, { block: ConfirmCardBlock }> = {
  name: "presentConfirmCard",
  description:
    "Display a Yes/No confirmation card for a deferred mutation. accept_action.tool must be one of: createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring. Server validates args against the target tool's schema before issuing the intent. Use this for destructive ops (removeRecurring) and ambiguous or large changes. The action runs only when the user taps accept.",
  args: Args,
  async run(ctx, args) {
    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { tool: args.accept_action.tool, args: args.accept_action.args },
    );
    return {
      block: {
        type: "confirm_card",
        question: args.question,
        acceptLabel: args.accept_label ?? "확인",
        rejectLabel: args.reject_label ?? "취소",
        acceptIntent: out.intent.id,
        expiresAt: out.intent.expiresAt,
      },
    };
  },
};
```

- [ ] **Step 4: Run — expect PASS (5/5)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.present-confirm-card.test.ts --reporter=basic 2>&1 | tail -10
```

### 3.3 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/present-confirm-card.ts apps/api/tests/chat.tools.present-confirm-card.test.ts
git commit -m "feat(plan 1c-confirmation): presentConfirmCard chat tool"
```

---

## Task 4: Chat turn integration (TDD)

**Files:**
- Modify: `apps/api/src/chat/turn.ts`
- Modify: `apps/api/src/routes/chat.ts`
- Create: `apps/api/tests/chat.turn.presentation-blocks.test.ts`

### 4.1 Failing test

- [ ] **Step 1: Create `apps/api/tests/chat.turn.presentation-blocks.test.ts`**

This test exercises the turn handler's block-collection logic. The exact stubbing pattern depends on `chat.turn.test.ts`'s existing approach — read that file first and mirror its setup. Required assertions:

```typescript
// Pseudocode — implementer adapts to existing chat.turn.test.ts harness.
// Two cases:

it("tool result with { block } shape appears in presentationBlocks", async () => {
  // Stub processChatTurn or its dependencies so a tool call returns
  //   { output: { block: { type: "confirm_card", ... } } }
  // Then call processChatTurn and assert:
  //   result.presentationBlocks.length === 1
  //   result.presentationBlocks[0].type === "confirm_card"
});

it("tool result without { block } shape does NOT pollute presentationBlocks", async () => {
  // Stub so a tool returns { output: { category: { id, name } } }.
  // Assert: result.presentationBlocks.length === 0
});
```

If `chat.turn.test.ts` mocks Gemini at a layer that makes injecting tool results painful, prefer a UNIT test of the collection function. Extract the collection logic into an exported helper:

```typescript
// apps/api/src/chat/turn.ts (new export)
export function collectPresentationBlocks(
  toolCalls: Array<{ result?: unknown }>,
): Block[] { … }
```

and unit-test that directly.

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.turn.presentation-blocks.test.ts --reporter=basic 2>&1 | tail -10
```

### 4.2 Implement in turn.ts

- [ ] **Step 3: Edit `apps/api/src/chat/turn.ts`**

Add the helper near the top of the file (after imports):

```typescript
import type { Block } from "./blocks.js";

export function collectPresentationBlocks(
  toolCalls: Array<{ result?: unknown }>,
): Block[] {
  const out: Block[] = [];
  for (const tc of toolCalls) {
    const r = tc.result;
    if (!r || typeof r !== "object") continue;
    // Dispatcher envelopes results as { output: ... } | { error: ... }.
    if (!("output" in r)) continue;
    const out_ = (r as { output?: unknown }).output;
    if (!out_ || typeof out_ !== "object") continue;
    if (!("block" in out_)) continue;
    out.push((out_ as { block: Block }).block);
  }
  return out;
}
```

Modify `processChatTurn`'s return statement at the end of the function to include `presentationBlocks`:

```typescript
return {
  assistantText,
  toolCalls,
  presentationBlocks: collectPresentationBlocks(toolCalls),
};
```

Update the return type:

```typescript
// Existing return type (search for `Promise<{ assistantText: ...`):
//   Promise<{ assistantText: string; toolCalls: ToolCall[] }>
// Becomes:
//   Promise<{ assistantText: string; toolCalls: ToolCall[]; presentationBlocks: Block[] }>
```

### 4.3 Wire into route

- [ ] **Step 4: Edit `apps/api/src/routes/chat.ts`** POST messages handler

Find the assistant message persist block (after `turn = await processChatTurn(...)`):

```typescript
// Before:
const assistantMessage = await prisma.$transaction(async (tx) => {
  const m = await tx.chatMessage.create({
    data: {
      threadId: thread.id,
      role: "assistant",
      blocks: [{ type: "text", markdown: turn.assistantText }],
    },
  });
  // ...
});
```

Replace the `blocks:` line:

```typescript
import type { Block } from "../chat/blocks.js";  // add this import at top of file

// Inside the handler:
const blocks: Block[] = [
  { type: "text", markdown: turn.assistantText },
  ...turn.presentationBlocks,
];
const assistantMessage = await prisma.$transaction(async (tx) => {
  const m = await tx.chatMessage.create({
    data: {
      threadId: thread.id,
      role: "assistant",
      blocks: blocks as never,  // Prisma typing for Json[] requires cast
    },
  });
  // ...
});
```

- [ ] **Step 5: Run — expect PASS (turn-handler test + all existing tests)**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.turn.presentation-blocks.test.ts tests/chat.turn.test.ts tests/chat.routes.test.ts --reporter=basic 2>&1 | tail -10
```

If existing chat.routes / chat.turn tests fail because the return shape changed, update those tests' type assertions to accept the new field. Do NOT change semantics — `presentationBlocks` is just additive.

### 4.4 Commit

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/chat/turn.ts apps/api/src/routes/chat.ts apps/api/tests/chat.turn.presentation-blocks.test.ts
git commit -m "feat(plan 1c-confirmation): turn handler emits presentationBlocks; route persists them"
```

---

## Task 5: HTTP route /intents/:id/consume

**Files:**
- Create: `apps/api/src/routes/intents.ts`
- Modify: `apps/api/src/server.ts`
- Create: `apps/api/tests/intents.routes.test.ts`

### 5.1 Failing route tests

- [ ] **Step 1: Read `apps/api/tests/budgets.routes.test.ts` for boilerplate**

The intents route test mirrors the budgets test pattern: in-process Fastify via the existing `buildApp` helper, `signUpAndGetCookie` for auth, `makePro` for tier.

- [ ] **Step 2: Create `apps/api/tests/intents.routes.test.ts`**

The 7 required cases:

```typescript
// Sketch — copy boilerplate from budgets.routes.test.ts exactly.
describe("POST /workspaces/:id/intents/:intentId/consume", () => {
  it("200 happy: returns { result: { category: {...} } } and marks consumed", async () => {
    // Sign up Pro user, create an intent via createIntentService directly,
    // POST consume → assert 200 + body.result.category.name matches the payload.
  });
  it("404 intent_not_found for unknown id", async () => { /* … */ });
  it("403 intent_owner_mismatch (cross-workspace)", async () => { /* … */ });
  it("410 intent_gone after first consume", async () => { /* … */ });
  it("402 upgrade_required on Free tier", async () => { /* … */ });
  it("400 workspace_mismatch when :id ≠ X-Workspace-Id", async () => { /* … */ });
  it("403 insufficient_role: editor consuming createCategory intent", async () => {
    // Owner creates the intent for createCategory; sign in as a second user
    // who's a workspace editor; POST consume → 403 insufficient_role.
    // (createCategory checks ctx.role === "owner" in its run, so dispatch throws.)
  });
});
```

- [ ] **Step 3: Run — expect FAIL (route missing)**

```bash
pnpm --filter @fina/api exec vitest run tests/intents.routes.test.ts --reporter=basic 2>&1 | tail -10
```

### 5.2 Implement the route

- [ ] **Step 4: Create `apps/api/src/routes/intents.ts`**

```typescript
import type { FastifyInstance } from "fastify";
import { requireWorkspaceContext, HttpError } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import { consumeIntentService } from "../intents/service.js";

export async function intentsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/intents/:intentId/consume", async (req, reply) => {
    const params = req.params as { id: string; intentId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      const result = await consumeIntentService(
        {
          workspaceId: ctx.membership.workspaceId,
          userId: ctx.session.userId,
          role: ctx.membership.role,
          env: app.fina.env,
        },
        params.intentId,
      );
      return reply.code(200).send(result);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const msg = (e as Error).message;
      if (msg === "intent_not_found") return reply.code(404).send({ error: "intent_not_found" });
      if (msg === "intent_owner_mismatch")
        return reply.code(403).send({ error: "intent_owner_mismatch" });
      if (msg === "intent_gone") return reply.code(410).send({ error: "intent_gone" });
      // Tool-thrown insufficient_role (editor consuming owner-only createCategory).
      if (msg === "insufficient_role")
        return reply.code(403).send({ error: "insufficient_role" });
      throw e;  // other tool errors propagate as 500 — acceptable v1
    }
  });
}
```

- [ ] **Step 5: Register in `apps/api/src/server.ts`**

Add the import (after `recurringRoutes`):

```typescript
import { intentsRoutes } from "./routes/intents.js";
```

And register inside the setup function (after `await app.register(recurringRoutes);`, before `await app.register(chatRoutes);`):

```typescript
  await app.register(intentsRoutes);
```

- [ ] **Step 6: Run — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/intents.routes.test.ts --reporter=basic 2>&1 | tail -10
```

### 5.3 Commit

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/intents.ts apps/api/src/server.ts apps/api/tests/intents.routes.test.ts
git commit -m "feat(plan 1c-confirmation): HTTP /intents/:id/consume route"
```

---

## Task 6: Register presentConfirmCard + system prompt + registry test

**Files:**
- Modify: `apps/api/src/chat/tools/index.ts`
- Modify: `apps/api/src/chat/turn.ts` (SYSTEM_PROMPT)
- Modify: `apps/api/tests/chat.tools.registry.test.ts`

### 6.1 Register tool

- [ ] **Step 1: Edit `apps/api/src/chat/tools/index.ts`**

Add the import alongside the other tool imports:

```typescript
import { presentConfirmCard } from "./present-confirm-card.js";
```

Append to `REGISTRY: ToolDef[]` (after the existing 21 entries — `removeRecurring as ToolDef,` is currently last):

```typescript
  presentConfirmCard as ToolDef,
```

### 6.2 Update SYSTEM_PROMPT

- [ ] **Step 2: Edit `apps/api/src/chat/turn.ts`**

Find the current write-tool sentence (mentions `createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring`). Replace ENTIRELY with:

```
For write tools (createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring), briefly confirm with the user before invoking unless the request is unambiguous. When you want a confirm-then-execute flow, call presentConfirmCard with `accept_action` set to the target tool + args — the user sees a Yes/No card and the action runs only when they tap accept. Use this for destructive ops (removeRecurring) and for changes the user might want to reconsider (e.g. tripling a budget, mapping a frequent merchant). Example unambiguous (direct call OK): '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘' or 'Starbucks를 Coffee 카테고리로 자동분류' or 'Netflix를 매월 19달러 정기지출로 추가, 다음 결제 2026-06-01'. Example needs presentConfirmCard: 'Netflix 정기지출 삭제해줘' or '식비 예산을 500→2000으로 늘려' or 'Starbucks를 다른 카테고리로 옮길까?'
```

(The literal in the file is a TypeScript template-string. Preserve quoting/concatenation — only swap content.)

### 6.3 Bump registry test

- [ ] **Step 3: Edit `apps/api/tests/chat.tools.registry.test.ts`**

a) **Update ALL three existing `expect(REGISTRY).toHaveLength(21);` assertions to `22`.** The current file has THREE such lines (1c-budget block, 1c-merchant-map block, 1c-recurring-persist block). Verify with `grep -n "toHaveLength" apps/api/tests/chat.tools.registry.test.ts` — expect 3 matches.

b) Update the misleading it-name strings to `"registry has 22 tools total"` (three locations).

c) Append a new describe block at the END of the file:

```typescript
describe("REGISTRY (plan 1c-confirmation)", () => {
  const EXPECTED = [
    [
      "presentConfirmCard",
      "Display a Yes/No confirmation card for a deferred mutation. accept_action.tool must be one of: createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring. Server validates args against the target tool's schema before issuing the intent. Use this for destructive ops (removeRecurring) and ambiguous or large changes. The action runs only when the user taps accept.",
    ],
  ] as const;

  it("contains the new tool name", () => {
    const names = REGISTRY.map((t) => t.name);
    for (const [n] of EXPECTED) expect(names).toContain(n);
  });

  it("uses the exact description string from the spec", () => {
    for (const [name, desc] of EXPECTED) {
      const tool = REGISTRY.find((t) => t.name === name);
      expect(tool?.description).toBe(desc);
    }
  });

  it("registry has 22 tools total", () => {
    expect(REGISTRY).toHaveLength(22);
  });

  it("presentConfirmCard is registered", () => {
    const names = REGISTRY.map((t) => t.name);
    expect(names).toContain("presentConfirmCard");
  });
});
```

- [ ] **Step 4: Run registry test — expect PASS**

```bash
pnpm --filter @fina/api exec vitest run tests/chat.tools.registry.test.ts --reporter=basic 2>&1 | tail -10
```

### 6.4 Commit

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/index.ts apps/api/src/chat/turn.ts apps/api/tests/chat.tools.registry.test.ts
git commit -m "feat(plan 1c-confirmation): register presentConfirmCard + prompt"
```

---

## Task 7: Full suite verification + final sanity

**Files:** none (verification only).

### 7.1 Run the full API suite via nx

- [ ] **Step 1: Reset nx + run**

```bash
pnpm exec nx reset 2>&1 | tail -2
pnpm nx run api:test --skipNxCache 2>&1 | tail -10
```

**Expected:** all files pass. Count = baseline 77 + 4 new = **81 files**. Tests = baseline 635 + ~28 new = **~663 tests** (±3 acceptable).

### 7.2 Sanity grep

- [ ] **Step 2: Confirm wiring**

```bash
grep -rn "intentsRoutes\|presentConfirmCard\|ActionIntent\|consumeIntentService\|createIntentService" apps/api/src/ | head -20
```

**Expected:**
- `routes/intents.ts` defines `intentsRoutes`.
- `server.ts` imports + registers `intentsRoutes`.
- `chat/tools/index.ts` imports + registers `presentConfirmCard`.
- `chat/turn.ts` SYSTEM_PROMPT mentions `presentConfirmCard`.
- `intents/service.ts` exports `createIntentService` + `consumeIntentService` + `CONFIRMABLE_TOOLS`.

### 7.3 Typecheck

- [ ] **Step 3: Confirm no new TS errors**

```bash
./node_modules/.bin/tsc --noEmit -p apps/api/tsconfig.app.json 2>&1 | grep "error TS" | head -10
```

**Expected:** the pre-existing `apps/api/src/chat/turn.ts:131` `InputJsonValue` error remains. NO new errors involving intents files.

### 7.4 No new dependency

- [ ] **Step 4: Confirm `package.json` unchanged**

```bash
git diff main -- apps/api/package.json package.json
```

**Expected:** no output.

---

## Self-Review Checklist (after all tasks)

1. **Spec coverage:** Every spec §4 model, §5 service, §6 chat tool, §7 turn integration, §8 route, §9 prompt is implemented.
2. **`as ToolDef` cast** is present on the new registry entry.
3. **`workspace_mismatch`** in consume route covered by test.
4. **`insufficient_role` → 403** mapping in consume route covered by test.
5. **Race-safe consume** verified by Promise.all test.
6. **System prompt** changed in exactly one place — the write-tool sentence.

---

## Known limitations (documented in spec §13)

- No `categorize_card`/`schedule_form`/`budget_edit` block types — separate plans.
- No reject endpoint (let intent expire).
- No cron cleanup of consumed/expired intents.
- No `audit_events` writes — separate 1C-audit plan.
- Fixed 1-hour TTL (not configurable per intent).
- No tool is forced through intent flow — LLM still chooses.
- Frontend renderer for `confirm_card` is user's UI track.
- Tool errors during consume surface as 500 in v1 — exception: `insufficient_role` → 403.

These are listed so a reviewer doesn't ask "why didn't you also fix X?" — the answer is "Section §13 of the spec".
