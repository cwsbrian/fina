# Chat Goals Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chat assistant goals capabilities — list goals, view a goal's detail/savings plan, and create/edit/archive goals — matching how it already handles budgets, recurring expenses, and transactions.

**Architecture:** Add three `PresentationBlock` types + one error code to `@fina/shared` FIRST. Extract a goals service (`apps/api/src/goals/service.ts`) from the inline CRUD in `routes/goals.ts`, enforcing the existing Pro-tier gate, and repoint the routes to it (behavior-preserving). Add 5 chat tools (`listGoals`, `getGoalDetails`, `presentGoalForm`, `addGoal`, `updateGoal`, `archiveGoal`) that call the service. The three writers are confirmable (form/confirm-card → intent → consume). On mobile, add `GoalsListBlock`, `GoalDetailBlock`, `GoalFormBlock`, wire them into the exhaustive `PresentationBlock` renderer + `isCardBlock`, and make the read cards tap through to `/goals` and `/goals/{id}`.

**Tech Stack:** TypeScript, Fastify + Prisma (apps/api), zod (`@fina/shared` schemas), Expo / React Native (apps/mobile), Vitest (real-DB integration tests).

**Branch:** `feat/chat-goals-tools` (already created off `main`).

**Standing constraints (do NOT violate):**
- Do **not** stage or commit the pre-existing uncommitted IAP/billing working-tree changes (`apps/mobile/...`, `pnpm-lock.yaml`, the `*.apk`, the `docs/superpowers/.../iap-billing-*` files). IAP is a separate work stream. Each task's `git add` lists exact paths — add only those.
- `@fina/shared` changes ship FIRST, in their own commit (Task 1), before any consumer.
- Verify api with `pnpm exec nx test api -- <pattern>`. Verify mobile types with `pnpm exec nx typecheck mobile`. Build shared with `pnpm exec nx build shared` after editing `libs/shared`.

---

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `libs/shared/src/dto/chat.ts` | Add `goals_list`, `goal_detail`, `goal_form_card` to the `PresentationBlock` union | Modify |
| `libs/shared/src/errors.ts` | Add `goal_not_found` to `API_ERROR_CODES` | Modify |
| `libs/shared/src/schemas/goals.ts` | Export `isDueDateAtLeastOneMonth(s)`; refactor `DueDateMinOneMonth` to use it | Modify |
| `apps/api/src/goals/service.ts` | Goals service: list/get/find-by-title/create/patch with Pro gate (DRY for routes + chat tools) | Create |
| `apps/api/src/routes/goals.ts` | Repoint to the service; drop now-dead local `dto`/`goalInclude`/`GoalRow`/tier check | Modify |
| `apps/api/src/chat/tools/list-goals.ts` | `listGoals` read tool → `goals_list` | Create |
| `apps/api/src/chat/tools/get-goal-details.ts` | `getGoalDetails` read tool (id or title) → `goal_detail` / `{ambiguous}` | Create |
| `apps/api/src/chat/tools/present-goal-form.ts` | `presentGoalForm` presenter → `goal_form_card` (Pro short-circuit) | Create |
| `apps/api/src/chat/tools/add-goal.ts` | `addGoal` confirmable writer | Create |
| `apps/api/src/chat/tools/update-goal.ts` | `updateGoal` confirmable writer | Create |
| `apps/api/src/chat/tools/archive-goal.ts` | `archiveGoal` confirmable writer | Create |
| `apps/api/src/chat/tools/index.ts` | Register the 6 tools in `REGISTRY` | Modify |
| `apps/api/src/intents/service.ts` | Add 3 writers to `CONFIRMABLE_TOOLS` + `confirmationFor` cases | Modify |
| `apps/api/src/audit/service.ts` | Add 3 writers to `AUDIT_WRITE_TOOLS` + `TARGET_TYPE_MAP` (`goal`) + `extractTargetId` branch | Modify |
| `apps/api/src/chat/tools/present-confirm-card.ts` | Add `updateGoal`/`archiveGoal` to the allowed-tools description string | Modify |
| `apps/api/src/chat/turn.ts` | Prompt routing keywords for goals | Modify |
| `apps/mobile/src/chat/blocks/GoalsListBlock.tsx` | Renders `goals_list`, taps → `/goals` | Create |
| `apps/mobile/src/chat/blocks/GoalDetailBlock.tsx` | Renders `goal_detail`, taps → `/goals/{id}` | Create |
| `apps/mobile/src/chat/blocks/GoalFormBlock.tsx` | Renders `goal_form_card` (title/target/due inputs) | Create |
| `apps/mobile/src/chat/PresentationBlock.tsx` | Wire 3 blocks into the exhaustive renderer | Modify |
| `apps/mobile/src/chat/ThreadView.tsx` | Add 3 block types to `isCardBlock` | Modify |
| `apps/api/tests/chat.tools.list-goals.test.ts` | Integration test | Create |
| `apps/api/tests/chat.tools.get-goal-details.test.ts` | Integration test | Create |
| `apps/api/tests/chat.tools.present-goal-form.test.ts` | Integration test | Create |
| `apps/api/tests/chat.tools.add-goal.test.ts` | Integration test (incl. tier gate + min due date) | Create |
| `apps/api/tests/chat.tools.update-archive-goal.test.ts` | Integration test | Create |

---

## Reference shapes (already in the codebase — do NOT redefine)

`GoalDTO` (`libs/shared/src/dto/goals.ts`), serialized by the API:

```ts
type GoalDTO = {
  id: string;
  title: string;
  description: string | null;
  targetAmount: string;   // decimal string, e.g. "2000.00"
  savedAmount: string;    // decimal string, COMPUTED via computeGoalSavings
  dueDate: string;        // "YYYY-MM-DD"
  icon: string | null;
  color: string | null;
  strategy: { generatedAt: string; notice?: string } | null;
  allocations: Array<{
    categoryId: string; categoryName: string;
    categoryIcon: string | null; categoryColor: string | null;
    monthlyAmount: string; rationale: string | null;
  }>;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

`CreateGoalBody` / `PatchGoalBody` (`libs/shared/src/schemas/goals.ts`), `CreateGoalInput` / `PatchGoalInput` inferred types. `minDueDateOneMonthUTC(now?)` returns the floor `Date`. `GOAL_TITLE_MAX_LEN=80`, `GOAL_DESCRIPTION_MAX_LEN=280`, `GOAL_MAX_AMOUNT=9_999_999.99`.

`ToolDef<TArgs, TResult>` and `ToolContext` (`apps/api/src/chat/tools/types.ts`):

```ts
type ToolContext = { env: Env; workspaceId: string; userId: string; role: Role };
type ToolDef<TArgs, TResult> = {
  name: string; description: string;
  args: z.ZodType<TArgs>;
  run: (ctx: ToolContext, args: TArgs) => Promise<TResult>;
};
```

`requireProTier(userId)` (`apps/api/src/auth/tier.ts`) throws `HttpError(402, "upgrade_required")` when the user's effective tier is not `pro`. A user is Pro when `trialEndsAt > now` (auto-started on bootstrap) or has an active lite/pro subscription.

`computeGoalSavings(workspaceId, goalId): Promise<number>` (`apps/api/src/goals/savings.ts`).

---

### Task 1: Shared block types, error code, and due-date predicate

**Files:**
- Modify: `libs/shared/src/dto/chat.ts` (end of the `PresentationBlock` union, around line 346)
- Modify: `libs/shared/src/errors.ts:8` (the `API_ERROR_CODES` array)
- Modify: `libs/shared/src/schemas/goals.ts`

- [ ] **Step 1: Add the three block types to the `PresentationBlock` union**

In `libs/shared/src/dto/chat.ts`, the union currently ends with the `category_list` member:

```ts
  | {
      /** Read-only category chips. Used by listCategories. */
      type: "category_list";
      title: string;
      rows: Array<{ id: string; name: string; color?: string | null; icon?: string | null }>;
      footer?: string;
    };
```

Change the trailing `;` on that member's closing `}` to `}` (no semicolon) and append the three new members so the union still terminates with a single `;`:

```ts
  | {
      /** Read-only category chips. Used by listCategories. */
      type: "category_list";
      title: string;
      rows: Array<{ id: string; name: string; color?: string | null; icon?: string | null }>;
      footer?: string;
    }
  | {
      /** Read-only goals card. Used by listGoals. Each row pairs a goal's
       *  COMPUTED `saved` with its `target` and a `bar_pct`
       *  (saved/target*100, may exceed 100). `over` is true when
       *  saved > target. `due_label` is a D-day string ("D-42", "D-DAY",
       *  "D+3" when overdue). Amounts are decimal strings without a
       *  currency symbol; the renderer formats with `currency`. */
      type: "goals_list";
      title: string;
      currency?: string;
      rows: Array<{
        id: string;
        title: string;
        saved: string;
        target: string;
        bar_pct: number;
        over?: boolean;
        due_label: string;
        icon?: string | null;
        color?: string | null;
      }>;
      footer?: string;
    }
  | {
      /** Single-goal detail card. Used by getGoalDetails. `note` is a
       *  TOOL-TEMPLATED constant explaining savings accrue automatically
       *  from staying under budget in the listed categories (NOT from
       *  data). `strategy_note` carries Goal.strategy.notice ONLY (set
       *  only when the LLM strategy generation failed; usually absent) —
       *  do not expect a positive plan sentence here. `allocations` are
       *  the per-category cuts from the saved plan. */
      type: "goal_detail";
      id: string;
      title: string;
      saved: string;
      target: string;
      bar_pct: number;
      over?: boolean;
      currency?: string;
      due_label: string;
      days_left?: number;
      note?: string;
      allocations?: Array<{
        category: { name: string; color?: string | null; icon?: string | null };
        monthly: string;
        rationale?: string;
      }>;
      strategy_note?: string;
    }
  | {
      /** Goal add/update form. Used by presentGoalForm. Mirrors
       *  recurring_form_card. `target_amount` is a decimal STRING for
       *  display; the stored intent arg is the NUMBER
       *  parseFloat(target_amount). `due_date` default is always
       *  >= minDueDateOneMonthUTC(). */
      type: "goal_form_card";
      question: string;
      intent_id: string;
      defaults: {
        title?: string;
        target_amount?: string;
        /** YYYY-MM-DD. */
        due_date?: string;
      };
      currency?: string;
      mode?: "add" | "update";
    };
```

- [ ] **Step 2: Add the `goal_not_found` error code**

In `libs/shared/src/errors.ts`, the `API_ERROR_CODES` array (line 8) contains the `*_not_found` codes (`budget_not_found`, `recurring_not_found`, …). Add `goal_not_found` next to the other not-found codes:

```ts
  "recurring_not_found",
  "goal_not_found",
  "intent_not_found",
```

- [ ] **Step 3: Export the shared due-date predicate and refactor the refine**

In `libs/shared/src/schemas/goals.ts`, the current refine inlines the comparison:

```ts
const DueDateMinOneMonth = DateOnly.refine(
  (s) => {
    const dueDate = new Date(`${s}T00:00:00.000Z`);
    return dueDate.getTime() >= minDueDateOneMonthUTC().getTime();
  },
  { message: "dueDate must be at least 1 calendar month from today" },
);
```

Replace it with an exported predicate (so the chat tools reuse the exact same rule) and a refine that calls it:

```ts
/** True when `s` (YYYY-MM-DD) is at least one calendar month from today
 *  (UTC). Single source of truth for the goal due-date floor — used by
 *  CreateGoalBody/PatchGoalBody AND the chat addGoal/updateGoal/
 *  presentGoalForm tools so a form submit can never fail the server
 *  refine. */
export function isDueDateAtLeastOneMonth(s: string): boolean {
  const dueDate = new Date(`${s}T00:00:00.000Z`);
  return dueDate.getTime() >= minDueDateOneMonthUTC().getTime();
}

const DueDateMinOneMonth = DateOnly.refine(isDueDateAtLeastOneMonth, {
  message: "dueDate must be at least 1 calendar month from today",
});
```

- [ ] **Step 4: Build shared and confirm it compiles**

Run: `pnpm exec nx build shared`
Expected: build succeeds, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add libs/shared/src/dto/chat.ts libs/shared/src/errors.ts libs/shared/src/schemas/goals.ts
git commit -m "feat(shared): goals chat block types + goal_not_found + due-date predicate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Extract the goals service and repoint the routes

**Files:**
- Create: `apps/api/src/goals/service.ts`
- Modify: `apps/api/src/routes/goals.ts`
- Test: existing `apps/api/tests/goals.routes.test.ts` must still pass (behavior-preserving)

- [ ] **Step 1: Run the existing goals route tests to confirm a green baseline**

Run: `pnpm exec nx test api -- goals.routes`
Expected: PASS (all existing goals route tests green).

- [ ] **Step 2: Create the goals service**

Create `apps/api/src/goals/service.ts`:

```ts
import { Prisma } from "@prisma/client";
import type { GoalDTO, CreateGoalInput, PatchGoalInput } from "@fina/shared";
import { prisma } from "../db.js";
import { requireProTier } from "../auth/tier.js";
import { computeGoalSavings } from "./savings.js";

const goalInclude = {
  allocations: {
    include: {
      category: { select: { name: true, icon: true, color: true } },
    },
    orderBy: { monthlyAmount: "desc" as const },
  },
};

type GoalRow = Prisma.GoalGetPayload<{ include: typeof goalInclude }>;

/** Build the wire DTO. `computedSaved` overrides the stored amount —
 *  goal savings are derived from actual under-budget behavior per the
 *  goal's allocations (see goals/savings.ts), not from manual input. */
function toDTO(g: GoalRow, computedSaved: number): GoalDTO {
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    targetAmount: g.targetAmount.toFixed(2),
    savedAmount: computedSaved.toFixed(2),
    dueDate: g.dueDate.toISOString().slice(0, 10),
    icon: g.icon,
    color: g.color,
    strategy: g.strategy as GoalDTO["strategy"],
    allocations: g.allocations.map((a) => ({
      categoryId: a.categoryId,
      categoryName: a.category.name,
      categoryIcon: a.category.icon,
      categoryColor: a.category.color,
      monthlyAmount: a.monthlyAmount.toFixed(2),
      rationale: a.rationale,
    })),
    archivedAt: g.archivedAt?.toISOString() ?? null,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}

/** YYYY-MM-DD → UTC noon, same convention as transactions. */
function dateOnly(s: string): Date {
  return new Date(`${s}T12:00:00.000Z`);
}

/** All non-archived goals, soonest due first, each with computed savings.
 *  Perf note: computeGoalSavings runs once per goal and each call
 *  re-reads workspace allocations + the default plan + a budgetPlan
 *  lookup per month — i.e. ~G×(3+M) queries. This matches the existing
 *  REST route (no worse than today); a batched version is a possible
 *  later optimization, not done here. */
export async function listGoalsWithSavings(
  workspaceId: string,
): Promise<GoalDTO[]> {
  const rows = await prisma.goal.findMany({
    where: { workspaceId, archivedAt: null },
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    include: goalInclude,
  });
  return Promise.all(
    rows.map(async (g) => toDTO(g, await computeGoalSavings(workspaceId, g.id))),
  );
}

/** One goal (archived or not) with computed savings, or null. */
export async function getGoalWithSavings(
  workspaceId: string,
  goalId: string,
): Promise<GoalDTO | null> {
  const row = await prisma.goal.findFirst({
    where: { id: goalId, workspaceId },
    include: goalInclude,
  });
  if (!row) return null;
  return toDTO(row, await computeGoalSavings(workspaceId, row.id));
}

/** Non-archived goals whose title CONTAINS `title` (case-insensitive),
 *  soonest due first. The caller decides 0/1/>1 handling. */
export async function findGoalsByTitle(
  workspaceId: string,
  title: string,
): Promise<GoalDTO[]> {
  const rows = await prisma.goal.findMany({
    where: {
      workspaceId,
      archivedAt: null,
      title: { contains: title, mode: "insensitive" },
    },
    orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    include: goalInclude,
  });
  return Promise.all(
    rows.map(async (g) => toDTO(g, await computeGoalSavings(workspaceId, g.id))),
  );
}

/** Create a goal. Pro-tier gated (throws HttpError(402) for non-Pro).
 *  Does NOT trigger strategy generation — the REST route owns that
 *  fire-and-forget call so chat-created goals don't auto-generate. */
export async function createGoalService(
  workspaceId: string,
  userId: string,
  input: CreateGoalInput,
): Promise<GoalDTO> {
  await requireProTier(userId);
  const created = await prisma.goal.create({
    data: {
      workspaceId,
      title: input.title.trim(),
      description: input.description ?? null,
      targetAmount: new Prisma.Decimal(input.targetAmount),
      savedAmount: new Prisma.Decimal(input.savedAmount ?? 0),
      dueDate: dateOnly(input.dueDate),
      icon: input.icon ?? null,
      color: input.color ?? null,
    },
    include: goalInclude,
  });
  return toDTO(created, await computeGoalSavings(workspaceId, created.id));
}

/** Patch a goal (incl. archived → archivedAt). Pro-tier gated. Returns
 *  null when the goal does not exist in the workspace. */
export async function patchGoalService(
  workspaceId: string,
  userId: string,
  goalId: string,
  input: PatchGoalInput,
): Promise<GoalDTO | null> {
  await requireProTier(userId);
  const row = await prisma.goal.findFirst({
    where: { id: goalId, workspaceId },
    select: { id: true },
  });
  if (!row) return null;
  const data: Prisma.GoalUpdateInput = {};
  if (input.title !== undefined) data.title = input.title.trim();
  if (input.description !== undefined) data.description = input.description;
  if (input.targetAmount !== undefined)
    data.targetAmount = new Prisma.Decimal(input.targetAmount);
  if (input.savedAmount !== undefined)
    data.savedAmount = new Prisma.Decimal(input.savedAmount);
  if (input.dueDate !== undefined) data.dueDate = dateOnly(input.dueDate);
  if (input.icon !== undefined) data.icon = input.icon;
  if (input.color !== undefined) data.color = input.color;
  if (input.archived !== undefined) {
    data.archivedAt = input.archived ? new Date() : null;
  }
  const updated = await prisma.goal.update({
    where: { id: row.id },
    data,
    include: goalInclude,
  });
  return toDTO(updated, await computeGoalSavings(workspaceId, updated.id));
}
```

- [ ] **Step 3: Repoint `routes/goals.ts` GET handlers to the service**

In `apps/api/src/routes/goals.ts`, replace the GET-list handler body (the `prisma.goal.findMany` + `Promise.all` + `dto`) with a call to `listGoalsWithSavings`. Note: the existing route honors an `includeArchived=true` query param; the service's `listGoalsWithSavings` returns non-archived only. Preserve the `includeArchived` behavior by keeping the inline query path ONLY when `includeArchived` is true, and using the service for the default path. Replace the GET-list handler so it reads:

```ts
  app.get("/workspaces/:id/goals", async (req, reply) => {
    const params = req.params as { id: string };
    const q = req.query as { includeArchived?: string };
    const includeArchived = q.includeArchived === "true";
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      if (includeArchived) {
        const rows = await prisma.goal.findMany({
          where: { workspaceId: ctx.membership.workspaceId },
          orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
          include: goalInclude,
        });
        const goals = await Promise.all(
          rows.map(async (g) =>
            dto(g, await computeGoalSavings(ctx.membership.workspaceId, g.id)),
          ),
        );
        return { goals };
      }
      const goals = await listGoalsWithSavings(ctx.membership.workspaceId);
      return { goals };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
```

Replace the GET-detail handler's body so the lookup + dto build comes from the service:

```ts
  app.get<{ Params: { id: string; goalId: string } }>(
    "/workspaces/:id/goals/:goalId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const goal = await getGoalWithSavings(
          ctx.membership.workspaceId,
          req.params.goalId,
        );
        if (!goal) return reply.code(404).send({ error: "not_found" });
        return { goal };
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        throw e;
      }
    },
  );
```

- [ ] **Step 4: Repoint the POST (create) handler to the service**

Replace the POST handler's tier check + `prisma.goal.create` + saved computation with a `createGoalService` call, keeping the fire-and-forget strategy generation in the route:

```ts
  app.post("/workspaces/:id/goals", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = CreateGoalBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const goal = await createGoalService(
        ctx.membership.workspaceId,
        ctx.session.userId,
        parsed.data,
      );
      // Fire-and-forget LLM strategy generation. The user gets an
      // immediate 201; the detail screen refetches and picks up the
      // strategy once Gemini returns.
      void generateAndStoreGoalStrategy(app.fina.env, goal.id).catch(() => {});
      return reply.code(201).send({ goal });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
```

- [ ] **Step 5: Repoint the PATCH handler to the service**

Replace the PATCH handler's tier check + find + update with a `patchGoalService` call:

```ts
  app.patch<{ Params: { id: string; goalId: string } }>(
    "/workspaces/:id/goals/:goalId",
    async (req, reply) => {
      const parsed = PatchGoalBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const goal = await patchGoalService(
          ctx.membership.workspaceId,
          ctx.session.userId,
          req.params.goalId,
          parsed.data,
        );
        if (!goal) return reply.code(404).send({ error: "not_found" });
        return reply.code(200).send({ goal });
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        throw e;
      }
    },
  );
```

- [ ] **Step 6: Repoint the strategy POST handler's read to the service**

In the `/workspaces/:id/goals/:goalId/strategy` handler, after `await generateAndStoreGoalStrategy(...)`, replace the `prisma.goal.findUniqueOrThrow` + `computeGoalSavings` + `dto` with `getGoalWithSavings`:

```ts
        // Wait for generation to complete (small + bounded) so the
        // caller can refresh once and see the new plan.
        await generateAndStoreGoalStrategy(app.fina.env, row.id);
        const goal = await getGoalWithSavings(ctx.membership.workspaceId, row.id);
        if (!goal) return reply.code(404).send({ error: "not_found" });
        return reply.code(200).send({ goal });
```

(Keep the preceding `effectiveTier` Pro gate + `row` existence check in this strategy handler as-is — only its final read changes.)

- [ ] **Step 7: Add the service imports and remove now-dead locals**

At the top of `routes/goals.ts`, add:

```ts
import {
  listGoalsWithSavings,
  getGoalWithSavings,
  createGoalService,
  patchGoalService,
} from "../goals/service.js";
```

The DELETE handler stays inline (`prisma.goal.deleteMany`). The strategy handler still uses `goalInclude`-free code now — but the `includeArchived` GET branch (Step 3) still references `dto`, `goalInclude`, and `computeGoalSavings`, so KEEP `dto`, `goalInclude`, `GoalRow`, `computeGoalSavings` import, and `Prisma` import. Remove only what is genuinely unused after the edits: the `dateOnly` local function and the `effectiveTier` import are now unused by create/patch — but the strategy handler still calls `effectiveTier`, so KEEP `effectiveTier`. The `dateOnly` function is now used only inside the service; if no remaining route code calls it, remove it from `routes/goals.ts`. After editing, let the typecheck (Step 8) flag any unused symbol and remove exactly those.

- [ ] **Step 8: Typecheck the api and run the route tests**

Run: `pnpm exec nx typecheck api`
Expected: PASS (no unused-symbol errors; if any appear, remove that exact symbol from `routes/goals.ts`).

Run: `pnpm exec nx test api -- goals.routes`
Expected: PASS — same `not_found` / `upgrade_required` / `invalid_body` HTTP codes as before. The extraction is behavior-preserving.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/goals/service.ts apps/api/src/routes/goals.ts
git commit -m "refactor(goals): extract goals service from inline routes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `listGoals` read tool

**Files:**
- Create: `apps/api/src/chat/tools/list-goals.ts`
- Test: `apps/api/tests/chat.tools.list-goals.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.list-goals.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { listGoals } from "../src/chat/tools/list-goals.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listGoals chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `lg-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LG", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "lg-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns no block when there are no goals", async () => {
    const r = await listGoals.run(ctx, {});
    expect(r.block).toBeUndefined();
    expect(r.goals).toHaveLength(0);
  });

  it("returns a goals_list with rows, bar_pct, and D-day label", async () => {
    await prisma.goal.create({
      data: {
        workspaceId: wsId,
        title: "Japan trip",
        targetAmount: new Prisma.Decimal(2000),
        savedAmount: new Prisma.Decimal(0),
        dueDate: new Date("2026-06-26T12:00:00.000Z"), // 42 days out
        icon: "airplane-outline",
        color: "#3366cc",
      },
    });
    const r = await listGoals.run(ctx, {});
    if (r.block?.type !== "goals_list") throw new Error("wrong block");
    expect(r.block.rows).toHaveLength(1);
    const row = r.block.rows[0]!;
    expect(row.title).toBe("Japan trip");
    expect(row.target).toBe("2000.00");
    expect(row.due_label).toBe("D-42");
    expect(typeof row.bar_pct).toBe("number");
  });

  it("excludes archived goals", async () => {
    await prisma.goal.create({
      data: {
        workspaceId: wsId, title: "Old", targetAmount: new Prisma.Decimal(100),
        savedAmount: new Prisma.Decimal(0), dueDate: new Date("2026-07-01T12:00:00.000Z"),
        archivedAt: new Date("2026-05-01T12:00:00.000Z"),
      },
    });
    const r = await listGoals.run(ctx, {});
    expect(r.block).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec nx test api -- chat.tools.list-goals`
Expected: FAIL — cannot find module `../src/chat/tools/list-goals.js`.

- [ ] **Step 3: Implement `listGoals`**

Create `apps/api/src/chat/tools/list-goals.ts`:

```ts
import { z } from "zod";
import type { GoalDTO, PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { listGoalsWithSavings } from "../../goals/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({});
type Args = z.infer<typeof Args>;

/** Max goal rows in the card; the rest live on the /goals screen. */
const MAX_ROWS = 6;

/** Build a D-day label from a YYYY-MM-DD due date relative to today
 *  (UTC). "D-42" upcoming, "D-DAY" today, "D+3" overdue. */
export function dDayLabel(dueDate: string, now: Date = new Date()): string {
  const due = new Date(`${dueDate}T00:00:00.000Z`).getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((due - today) / 86_400_000);
  if (days > 0) return `D-${days}`;
  if (days === 0) return "D-DAY";
  return `D+${-days}`;
}

export function daysLeft(dueDate: string, now: Date = new Date()): number {
  const due = new Date(`${dueDate}T00:00:00.000Z`).getTime();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((due - today) / 86_400_000);
}

export const listGoals: ToolDef<
  Args,
  { goals: GoalDTO[]; block?: PresentationBlock }
> = {
  name: "listGoals",
  description:
    "Show the user's savings goals — each with progress (saved/target), a percent bar, and a D-day until the due date. Savings are COMPUTED automatically from staying under budget; there is no manual deposit. Returns no card when the user has no goals (say they can set one up).",
  args: Args,
  async run(ctx, _args) {
    const [goals, workspace] = await Promise.all([
      listGoalsWithSavings(ctx.workspaceId),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);
    if (goals.length === 0) return { goals };

    const shown = goals.slice(0, MAX_ROWS);
    const rows = shown.map((g) => {
      const saved = parseFloat(g.savedAmount);
      const target = parseFloat(g.targetAmount);
      return {
        id: g.id,
        title: g.title,
        saved: g.savedAmount,
        target: g.targetAmount,
        bar_pct: target > 0 ? Number(((saved / target) * 100).toFixed(2)) : 0,
        over: saved > target,
        due_label: dDayLabel(g.dueDate),
        icon: g.icon,
        color: g.color,
      };
    });

    const block: PresentationBlock = {
      type: "goals_list",
      title: "Goals",
      currency: workspace.currency,
      rows,
      ...(goals.length > shown.length
        ? { footer: `+${goals.length - shown.length} more · See all goals` }
        : { footer: "See all goals" }),
    };
    return { goals, block };
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec nx test api -- chat.tools.list-goals`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/list-goals.ts apps/api/tests/chat.tools.list-goals.test.ts
git commit -m "feat(chat): listGoals tool -> goals_list card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `getGoalDetails` read tool (id or title)

**Files:**
- Create: `apps/api/src/chat/tools/get-goal-details.ts`
- Test: `apps/api/tests/chat.tools.get-goal-details.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.get-goal-details.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { getGoalDetails } from "../src/chat/tools/get-goal-details.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getGoalDetails chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  async function seedGoal(title: string, archived = false): Promise<string> {
    const g = await prisma.goal.create({
      data: {
        workspaceId: wsId,
        title,
        targetAmount: new Prisma.Decimal(2000),
        savedAmount: new Prisma.Decimal(0),
        dueDate: new Date("2026-06-26T12:00:00.000Z"),
        ...(archived ? { archivedAt: new Date("2026-05-01T12:00:00.000Z") } : {}),
      },
    });
    return g.id;
  }

  beforeEach(async () => {
    const stamp = `gd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "GD", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "gd-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns goal_detail by id", async () => {
    const id = await seedGoal("Japan trip");
    const r = await getGoalDetails.run(ctx, { goal_id: id });
    if (r.block?.type !== "goal_detail") throw new Error("wrong block");
    expect(r.block.id).toBe(id);
    expect(r.block.title).toBe("Japan trip");
    expect(r.block.due_label).toBe("D-42");
    expect(r.block.days_left).toBe(42);
    expect(r.block.note).toBeTruthy();
  });

  it("resolves a single title match to goal_detail", async () => {
    await seedGoal("Japan trip");
    const r = await getGoalDetails.run(ctx, { title: "japan" });
    if (r.block?.type !== "goal_detail") throw new Error("wrong block");
    expect(r.block.title).toBe("Japan trip");
  });

  it("returns ambiguous (no block) when >1 title matches", async () => {
    await seedGoal("Trip to Japan");
    await seedGoal("Trip to Italy");
    const r = await getGoalDetails.run(ctx, { title: "trip" });
    expect(r.ambiguous).toBe(true);
    expect(r.block).toBeUndefined();
  });

  it("throws goal_not_found when title matches nothing", async () => {
    await seedGoal("Japan trip");
    await expect(getGoalDetails.run(ctx, { title: "house" })).rejects.toThrow("goal_not_found");
  });

  it("does not match archived goals by title", async () => {
    await seedGoal("Japan trip", true);
    await expect(getGoalDetails.run(ctx, { title: "japan" })).rejects.toThrow("goal_not_found");
  });

  it("throws goal_not_found for an unknown id", async () => {
    await expect(getGoalDetails.run(ctx, { goal_id: "nope" })).rejects.toThrow("goal_not_found");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec nx test api -- chat.tools.get-goal-details`
Expected: FAIL — cannot find module `../src/chat/tools/get-goal-details.js`.

- [ ] **Step 3: Implement `getGoalDetails`**

Create `apps/api/src/chat/tools/get-goal-details.ts`:

```ts
import { z } from "zod";
import type { GoalDTO, PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { getGoalWithSavings, findGoalsByTitle } from "../../goals/service.js";
import { dDayLabel, daysLeft } from "./list-goals.js";
import type { ToolDef } from "./types.js";

const Args = z
  .object({
    goal_id: z.string().min(1).optional(),
    title: z.string().min(1).max(80).optional(),
  })
  .refine((a) => !!a.goal_id !== !!a.title, {
    message: "Provide exactly one of goal_id or title",
  });
type Args = z.infer<typeof Args>;

/** Static explainer rendered on every goal_detail card — savings are
 *  derived, not deposited. NOT data-driven. */
const SAVINGS_NOTE =
  "Savings grow automatically as you stay under budget in these categories.";

function toBlock(
  g: GoalDTO,
  currency: string,
): Extract<PresentationBlock, { type: "goal_detail" }> {
  const saved = parseFloat(g.savedAmount);
  const target = parseFloat(g.targetAmount);
  return {
    type: "goal_detail",
    id: g.id,
    title: g.title,
    saved: g.savedAmount,
    target: g.targetAmount,
    bar_pct: target > 0 ? Number(((saved / target) * 100).toFixed(2)) : 0,
    over: saved > target,
    currency,
    due_label: dDayLabel(g.dueDate),
    days_left: daysLeft(g.dueDate),
    note: SAVINGS_NOTE,
    ...(g.allocations.length > 0
      ? {
          allocations: g.allocations.map((a) => ({
            category: {
              name: a.categoryName,
              color: a.categoryColor,
              icon: a.categoryIcon,
            },
            monthly: a.monthlyAmount,
            ...(a.rationale ? { rationale: a.rationale } : {}),
          })),
        }
      : {}),
    ...(g.strategy?.notice ? { strategy_note: g.strategy.notice } : {}),
  };
}

export const getGoalDetails: ToolDef<
  Args,
  { goal?: GoalDTO; block?: PresentationBlock; ambiguous?: boolean }
> = {
  name: "getGoalDetails",
  description:
    "Show one goal in detail — progress, due date/pace, and its per-category savings plan. Pass goal_id (from a prior goals_list/goal_detail card) OR title (a word from the goal's name). If the title matches more than one goal, the tool returns ambiguous=true — then call listGoals to show the picker instead of asking the user which one.",
  args: Args,
  async run(ctx, args) {
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { currency: true },
    });

    if (args.goal_id) {
      const goal = await getGoalWithSavings(ctx.workspaceId, args.goal_id);
      if (!goal || goal.archivedAt) throw new Error("goal_not_found");
      return { goal, block: toBlock(goal, workspace.currency) };
    }

    const matches = await findGoalsByTitle(ctx.workspaceId, args.title!);
    if (matches.length === 0) throw new Error("goal_not_found");
    if (matches.length > 1) return { ambiguous: true };
    const goal = matches[0]!;
    return { goal, block: toBlock(goal, workspace.currency) };
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec nx test api -- chat.tools.get-goal-details`
Expected: PASS (6/6).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/get-goal-details.ts apps/api/tests/chat.tools.get-goal-details.test.ts
git commit -m "feat(chat): getGoalDetails tool -> goal_detail card (id or title)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `addGoal` confirmable writer + registrations

**Files:**
- Create: `apps/api/src/chat/tools/add-goal.ts`
- Modify: `apps/api/src/intents/service.ts` (`CONFIRMABLE_TOOLS`, `confirmationFor`)
- Modify: `apps/api/src/audit/service.ts` (`AUDIT_WRITE_TOOLS`, `TARGET_TYPE_MAP`, `extractTargetId`)
- Test: `apps/api/tests/chat.tools.add-goal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.add-goal.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { addGoal } from "../src/chat/tools/add-goal.js";
import { minDueDateOneMonthUTC } from "@fina/shared";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("addGoal chat tool", () => {
  let wsId: string;
  let proCtx: ToolContext;
  let freeCtx: ToolContext;

  function isoPlusDays(n: number): string {
    return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  }

  beforeEach(async () => {
    const stamp = `ag-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: "ag-ws", currency: "CAD" } });
    wsId = ws.id;
    // Pro: trial active (future trialEndsAt).
    const pro = await prisma.user.create({
      data: { id: `${stamp}-pro`, email: `${stamp}-pro@t.co`, name: "Pro", tz: "America/Toronto", trialEndsAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    await prisma.membership.create({ data: { userId: pro.id, workspaceId: wsId, role: "owner" } });
    proCtx = { env: {} as never, workspaceId: wsId, userId: pro.id, role: "owner" };
    // Free: trial expired, no subscription.
    const free = await prisma.user.create({
      data: { id: `${stamp}-free`, email: `${stamp}-free@t.co`, name: "Free", tz: "America/Toronto", trialEndsAt: new Date(Date.now() - 86_400_000), trialConsumed: true },
    });
    await prisma.membership.create({ data: { userId: free.id, workspaceId: wsId, role: "editor" } });
    freeCtx = { env: {} as never, workspaceId: wsId, userId: free.id, role: "editor" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("creates a goal for a Pro user", async () => {
    const r = await addGoal.run(proCtx, {
      title: "Japan trip",
      target_amount: 2000,
      due_date: isoPlusDays(60),
    });
    expect(r.goal.title).toBe("Japan trip");
    expect(r.goal.targetAmount).toBe("2000.00");
    const inDb = await prisma.goal.findFirst({ where: { workspaceId: wsId, title: "Japan trip" } });
    expect(inDb).not.toBeNull();
  });

  it("rejects a non-Pro user with upgrade_required", async () => {
    await expect(
      addGoal.run(freeCtx, { title: "X", target_amount: 100, due_date: isoPlusDays(60) }),
    ).rejects.toMatchObject({ code: "upgrade_required" });
  });

  it("rejects a due date sooner than one month at the arg-schema layer", () => {
    const tooSoon = new Date(minDueDateOneMonthUTC().getTime() - 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const parsed = addGoal.args.safeParse({ title: "X", target_amount: 100, due_date: tooSoon });
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec nx test api -- chat.tools.add-goal`
Expected: FAIL — cannot find module `../src/chat/tools/add-goal.js`.

- [ ] **Step 3: Implement `addGoal`**

Create `apps/api/src/chat/tools/add-goal.ts`:

```ts
import { z } from "zod";
import {
  GOAL_TITLE_MAX_LEN,
  GOAL_DESCRIPTION_MAX_LEN,
  GOAL_MAX_AMOUNT,
  isDueDateAtLeastOneMonth,
  type GoalDTO,
} from "@fina/shared";
import { createGoalService } from "../../goals/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN),
  target_amount: z.number().positive().max(GOAL_MAX_AMOUNT),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isDueDateAtLeastOneMonth, {
      message: "due_date must be at least 1 calendar month from today",
    }),
  description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
});
type Args = z.infer<typeof Args>;

export const addGoal: ToolDef<Args, { goal: GoalDTO }> = {
  name: "addGoal",
  description:
    "Create a savings goal. Pro-tier only. target_amount is a number; due_date is YYYY-MM-DD and must be at least one month out. Savings accrue automatically from staying under budget — do NOT promise a manual deposit. Usually issued via presentGoalForm (the form collects/edits the fields), not called directly.",
  args: Args,
  async run(ctx, args) {
    const goal = await createGoalService(ctx.workspaceId, ctx.userId, {
      title: args.title,
      targetAmount: args.target_amount,
      dueDate: args.due_date,
      ...(args.description !== undefined ? { description: args.description } : {}),
    });
    return { goal };
  },
};
```

- [ ] **Step 4: Register `addGoal` as confirmable**

In `apps/api/src/intents/service.ts`, add `"addGoal"` to the `CONFIRMABLE_TOOLS` array:

```ts
  "removeScheduledSpend",
  "addGoal",
] as const;
```

- [ ] **Step 5: Register `addGoal` for audit**

In `apps/api/src/audit/service.ts`, add `"addGoal"` to `AUDIT_WRITE_TOOLS`:

```ts
  "removeScheduledSpend",
  "addGoal",
]);
```

Add to `TARGET_TYPE_MAP`:

```ts
  removeScheduledSpend: "scheduled_spend",
  addGoal: "goal",
};
```

Add an `extractTargetId` branch before the final `return null;`:

```ts
  if (action === "addGoal") {
    const g = (result as Record<string, unknown>).goal as Record<string, unknown> | undefined;
    return typeof g?.id === "string" ? g.id : null;
  }
```

- [ ] **Step 6: Add the `addGoal` confirmation message**

In `apps/api/src/intents/service.ts`, inside `confirmationFor`'s `switch (tool)`, add a case (before `default:`):

```ts
    case "addGoal": {
      const g = (result as { goal?: { title: string; targetAmount: string; dueDate: string } }).goal;
      if (!g) return null;
      return ko
        ? `${g.title} 목표를 만들었어요 — ${g.dueDate}까지 $${g.targetAmount}.`
        : `Created goal "${g.title}" — $${g.targetAmount} by ${g.dueDate}.`;
    }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm exec nx test api -- chat.tools.add-goal`
Expected: PASS (3/3).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/chat/tools/add-goal.ts apps/api/src/intents/service.ts apps/api/src/audit/service.ts apps/api/tests/chat.tools.add-goal.test.ts
git commit -m "feat(chat): addGoal confirmable writer + intent/audit registration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: `updateGoal` + `archiveGoal` confirmable writers

**Files:**
- Create: `apps/api/src/chat/tools/update-goal.ts`
- Create: `apps/api/src/chat/tools/archive-goal.ts`
- Modify: `apps/api/src/intents/service.ts` (`CONFIRMABLE_TOOLS`, `confirmationFor`)
- Modify: `apps/api/src/audit/service.ts` (`AUDIT_WRITE_TOOLS`, `TARGET_TYPE_MAP`, `extractTargetId`)
- Modify: `apps/api/src/chat/tools/present-confirm-card.ts` (description string)
- Test: `apps/api/tests/chat.tools.update-archive-goal.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.update-archive-goal.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { updateGoal } from "../src/chat/tools/update-goal.js";
import { archiveGoal } from "../src/chat/tools/archive-goal.js";
import { listGoals } from "../src/chat/tools/list-goals.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("updateGoal + archiveGoal chat tools", () => {
  let wsId: string;
  let proCtx: ToolContext;
  let freeCtx: ToolContext;

  function isoPlusDays(n: number): string {
    return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  }

  async function seedGoal(): Promise<string> {
    const g = await prisma.goal.create({
      data: {
        workspaceId: wsId, title: "Japan trip",
        targetAmount: new Prisma.Decimal(2000), savedAmount: new Prisma.Decimal(0),
        dueDate: new Date(Date.now() + 60 * 86_400_000),
      },
    });
    return g.id;
  }

  beforeEach(async () => {
    const stamp = `ua-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: "ua-ws", currency: "CAD" } });
    wsId = ws.id;
    const pro = await prisma.user.create({
      data: { id: `${stamp}-pro`, email: `${stamp}-pro@t.co`, name: "Pro", tz: "America/Toronto", trialEndsAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    await prisma.membership.create({ data: { userId: pro.id, workspaceId: wsId, role: "owner" } });
    proCtx = { env: {} as never, workspaceId: wsId, userId: pro.id, role: "owner" };
    const free = await prisma.user.create({
      data: { id: `${stamp}-free`, email: `${stamp}-free@t.co`, name: "Free", tz: "America/Toronto", trialEndsAt: new Date(Date.now() - 86_400_000), trialConsumed: true },
    });
    await prisma.membership.create({ data: { userId: free.id, workspaceId: wsId, role: "editor" } });
    freeCtx = { env: {} as never, workspaceId: wsId, userId: free.id, role: "editor" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("updateGoal patches the target amount", async () => {
    const id = await seedGoal();
    const r = await updateGoal.run(proCtx, { goal_id: id, target_amount: 3000 });
    expect(r.goal.targetAmount).toBe("3000.00");
  });

  it("updateGoal rejects a non-Pro user", async () => {
    const id = await seedGoal();
    await expect(updateGoal.run(freeCtx, { goal_id: id, target_amount: 3000 })).rejects.toMatchObject({ code: "upgrade_required" });
  });

  it("updateGoal throws goal_not_found for an unknown id", async () => {
    await expect(updateGoal.run(proCtx, { goal_id: "nope", target_amount: 3000 })).rejects.toThrow("goal_not_found");
  });

  it("archiveGoal archives the goal and removes it from listGoals", async () => {
    const id = await seedGoal();
    const r = await archiveGoal.run(proCtx, { goal_id: id });
    expect(r.goal.archivedAt).not.toBeNull();
    const list = await listGoals.run(proCtx, {});
    expect(list.block).toBeUndefined();
  });

  it("archiveGoal rejects a non-Pro user", async () => {
    const id = await seedGoal();
    await expect(archiveGoal.run(freeCtx, { goal_id: id })).rejects.toMatchObject({ code: "upgrade_required" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec nx test api -- chat.tools.update-archive-goal`
Expected: FAIL — cannot find module `../src/chat/tools/update-goal.js`.

- [ ] **Step 3: Implement `updateGoal`**

Create `apps/api/src/chat/tools/update-goal.ts`:

```ts
import { z } from "zod";
import {
  GOAL_TITLE_MAX_LEN,
  GOAL_DESCRIPTION_MAX_LEN,
  GOAL_MAX_AMOUNT,
  isDueDateAtLeastOneMonth,
  type GoalDTO,
} from "@fina/shared";
import { patchGoalService } from "../../goals/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  goal_id: z.string().min(1),
  title: z.string().trim().min(1).max(GOAL_TITLE_MAX_LEN).optional(),
  target_amount: z.number().positive().max(GOAL_MAX_AMOUNT).optional(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isDueDateAtLeastOneMonth, {
      message: "due_date must be at least 1 calendar month from today",
    })
    .optional(),
  description: z.string().max(GOAL_DESCRIPTION_MAX_LEN).optional().nullable(),
});
type Args = z.infer<typeof Args>;

export const updateGoal: ToolDef<Args, { goal: GoalDTO }> = {
  name: "updateGoal",
  description:
    "Edit an existing goal's title, target_amount, or due_date. Pro-tier only. goal_id comes from a prior goals_list/goal_detail card. due_date (if changed) must be at least one month out. Cannot change saved amount — savings are computed automatically.",
  args: Args,
  async run(ctx, args) {
    const patch: Record<string, unknown> = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.target_amount !== undefined) patch.targetAmount = args.target_amount;
    if (args.due_date !== undefined) patch.dueDate = args.due_date;
    if (args.description !== undefined) patch.description = args.description;
    const goal = await patchGoalService(ctx.workspaceId, ctx.userId, args.goal_id, patch);
    if (!goal) throw new Error("goal_not_found");
    return { goal };
  },
};
```

- [ ] **Step 4: Implement `archiveGoal`**

Create `apps/api/src/chat/tools/archive-goal.ts`:

```ts
import { z } from "zod";
import type { GoalDTO } from "@fina/shared";
import { patchGoalService } from "../../goals/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  goal_id: z.string().min(1),
});
type Args = z.infer<typeof Args>;

export const archiveGoal: ToolDef<Args, { goal: GoalDTO }> = {
  name: "archiveGoal",
  description:
    "Archive a goal so it no longer appears in the user's active goals. Pro-tier only. goal_id comes from a prior goals_list/goal_detail card. Use presentConfirmCard before archiving so the user confirms.",
  args: Args,
  async run(ctx, args) {
    const goal = await patchGoalService(ctx.workspaceId, ctx.userId, args.goal_id, {
      archived: true,
    });
    if (!goal) throw new Error("goal_not_found");
    return { goal };
  },
};
```

- [ ] **Step 5: Register both in `CONFIRMABLE_TOOLS`**

In `apps/api/src/intents/service.ts`:

```ts
  "addGoal",
  "updateGoal",
  "archiveGoal",
] as const;
```

- [ ] **Step 6: Register both for audit**

In `apps/api/src/audit/service.ts` — add to `AUDIT_WRITE_TOOLS`:

```ts
  "addGoal",
  "updateGoal",
  "archiveGoal",
]);
```

Add to `TARGET_TYPE_MAP`:

```ts
  addGoal: "goal",
  updateGoal: "goal",
  archiveGoal: "goal",
};
```

Extend the `extractTargetId` `addGoal` branch to cover all three (they all return `{ goal }`):

```ts
  if (action === "addGoal" || action === "updateGoal" || action === "archiveGoal") {
    const g = (result as Record<string, unknown>).goal as Record<string, unknown> | undefined;
    return typeof g?.id === "string" ? g.id : null;
  }
```

- [ ] **Step 7: Add confirmation messages for both**

In `apps/api/src/intents/service.ts` `confirmationFor`, add two cases:

```ts
    case "updateGoal": {
      const g = (result as { goal?: { title: string } }).goal;
      return ko
        ? `${g?.title ?? "목표"}을 수정했어요.`
        : `Updated goal "${g?.title ?? "goal"}".`;
    }
    case "archiveGoal": {
      const g = (result as { goal?: { title: string } }).goal;
      return ko
        ? `${g?.title ?? "목표"}을 보관했어요.`
        : `Archived goal "${g?.title ?? "goal"}".`;
    }
```

- [ ] **Step 8: Extend the presentConfirmCard description**

In `apps/api/src/chat/tools/present-confirm-card.ts`, the description lists the allowed `accept_action.tool` values. Append `updateGoal, archiveGoal` to that list so the LLM knows it can route goal edits/archives through the confirm card:

```ts
    "Display a Yes/No confirmation card for a deferred mutation. accept_action.tool must be one of: createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring, addScheduledSpend, dismissScheduledSpend, removeScheduledSpend, updateGoal, archiveGoal. Server validates args against the target tool's schema before issuing the intent. Use this for destructive ops (removeRecurring, archiveGoal) and ambiguous or large changes. The action runs only when the user taps accept.",
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `pnpm exec nx test api -- chat.tools.update-archive-goal`
Expected: PASS (5/5).

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/chat/tools/update-goal.ts apps/api/src/chat/tools/archive-goal.ts apps/api/src/intents/service.ts apps/api/src/audit/service.ts apps/api/src/chat/tools/present-confirm-card.ts apps/api/tests/chat.tools.update-archive-goal.test.ts
git commit -m "feat(chat): updateGoal + archiveGoal confirmable writers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: `presentGoalForm` presenter (Pro short-circuit + due-date clamp)

**Files:**
- Create: `apps/api/src/chat/tools/present-goal-form.ts`
- Test: `apps/api/tests/chat.tools.present-goal-form.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/chat.tools.present-goal-form.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { presentGoalForm } from "../src/chat/tools/present-goal-form.js";
import { isDueDateAtLeastOneMonth } from "@fina/shared";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("presentGoalForm chat tool", () => {
  let wsId: string;
  let proCtx: ToolContext;
  let freeCtx: ToolContext;

  beforeEach(async () => {
    const stamp = `pf-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: "pf-ws", currency: "CAD" } });
    wsId = ws.id;
    const pro = await prisma.user.create({
      data: { id: `${stamp}-pro`, email: `${stamp}-pro@t.co`, name: "Pro", tz: "America/Toronto", trialEndsAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    await prisma.membership.create({ data: { userId: pro.id, workspaceId: wsId, role: "owner" } });
    proCtx = { env: {} as never, workspaceId: wsId, userId: pro.id, role: "owner" };
    const free = await prisma.user.create({
      data: { id: `${stamp}-free`, email: `${stamp}-free@t.co`, name: "Free", tz: "America/Toronto", trialEndsAt: new Date(Date.now() - 86_400_000), trialConsumed: true },
    });
    await prisma.membership.create({ data: { userId: free.id, workspaceId: wsId, role: "editor" } });
    freeCtx = { env: {} as never, workspaceId: wsId, userId: free.id, role: "editor" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns a goal_form_card with an add intent for a Pro user", async () => {
    const r = await presentGoalForm.run(proCtx, {
      question: "새 목표를 만들까요?",
      defaults: { title: "Japan trip", target_amount: 2000 },
    });
    if (r.block.type !== "goal_form_card") throw new Error("wrong block");
    expect(r.block.mode).toBe("add");
    expect(r.block.intent_id).toBeTruthy();
    expect(r.block.defaults.title).toBe("Japan trip");
    expect(r.block.defaults.target_amount).toBe("2000.00");
    // The default due date must satisfy the server's 1-month floor.
    expect(isDueDateAtLeastOneMonth(r.block.defaults.due_date!)).toBe(true);
  });

  it("clamps a too-soon inferred due date up to the floor", async () => {
    const r = await presentGoalForm.run(proCtx, {
      question: "q",
      defaults: { title: "X", target_amount: 100, due_date: "2026-05-20" },
    });
    if (r.block.type !== "goal_form_card") throw new Error("wrong block");
    expect(isDueDateAtLeastOneMonth(r.block.defaults.due_date!)).toBe(true);
  });

  it("returns update mode + carries goal_id when given an existing goal", async () => {
    const g = await prisma.goal.create({
      data: { workspaceId: wsId, title: "Japan trip", targetAmount: new Prisma.Decimal(2000), savedAmount: new Prisma.Decimal(0), dueDate: new Date(Date.now() + 90 * 86_400_000) },
    });
    const r = await presentGoalForm.run(proCtx, { question: "q", goal_id: g.id, defaults: { target_amount: 3000 } });
    if (r.block.type !== "goal_form_card") throw new Error("wrong block");
    expect(r.block.mode).toBe("update");
    expect(r.block.defaults.title).toBe("Japan trip"); // filled from existing
    expect(r.block.defaults.target_amount).toBe("3000.00"); // override wins
  });

  it("short-circuits a non-Pro user to a text 'Pro feature' block (no form)", async () => {
    const r = await presentGoalForm.run(freeCtx, {
      question: "q",
      defaults: { title: "X", target_amount: 100 },
    });
    expect(r.block.type).toBe("text");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec nx test api -- chat.tools.present-goal-form`
Expected: FAIL — cannot find module `../src/chat/tools/present-goal-form.js`.

- [ ] **Step 3: Implement `presentGoalForm`**

Create `apps/api/src/chat/tools/present-goal-form.ts`:

```ts
import { z } from "zod";
import {
  GOAL_TITLE_MAX_LEN,
  GOAL_MAX_AMOUNT,
  minDueDateOneMonthUTC,
  isDueDateAtLeastOneMonth,
  type PresentationBlock,
} from "@fina/shared";
import { prisma } from "../../db.js";
import { effectiveTier } from "../../auth/tier.js";
import { createIntentService } from "../../intents/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  question: z.string().min(1).max(500),
  goal_id: z.string().min(1).optional(),
  defaults: z.object({
    title: z.string().min(1).max(GOAL_TITLE_MAX_LEN).optional(),
    target_amount: z.number().positive().max(GOAL_MAX_AMOUNT).optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
});
type Args = z.infer<typeof Args>;

type FormDefaults = NonNullable<
  Extract<PresentationBlock, { type: "goal_form_card" }>["defaults"]
>;

/** YYYY-MM-DD for the min-due-date floor (today + 1 month, UTC). */
function floorDateStr(): string {
  return minDueDateOneMonthUTC().toISOString().slice(0, 10);
}

export const presentGoalForm: ToolDef<Args, { block: PresentationBlock }> = {
  name: "presentGoalForm",
  description:
    "Display an inline form for creating OR editing a savings goal. Use for BOTH intents. Pass goal_id to edit an existing goal (the form pre-fills from it; any defaults you pass override). Pre-fill title / target_amount / due_date from the user's message where you can. Goals are a Pro feature — for a non-Pro user this returns a short upgrade message instead of a form. Savings accrue automatically; do NOT collect a 'saved' amount.",
  args: Args,
  async run(ctx, args) {
    // Pro gate up-front so a non-Pro user never fills a form that would
    // fail on submit.
    const tier = await effectiveTier(ctx.userId);
    if (tier.tier !== "pro") {
      return {
        block: {
          type: "text",
          markdown:
            "목표는 Pro 기능이에요 — 목표를 만들거나 수정하려면 Pro로 업그레이드해 주세요. / Goals are a Pro feature — upgrade to Pro to create or edit goals.",
        },
      };
    }

    // Edit mode: look up the existing goal to pre-fill omitted fields.
    let existing:
      | { title: string; targetAmount: { toFixed(n: number): string }; dueDate: Date }
      | null = null;
    if (args.goal_id) {
      existing = await prisma.goal.findFirst({
        where: { id: args.goal_id, workspaceId: ctx.workspaceId },
        select: { title: true, targetAmount: true, dueDate: true },
      });
    }

    // Merge: explicit defaults WIN over existing values.
    const title = args.defaults.title ?? existing?.title;
    const targetNum =
      args.defaults.target_amount ??
      (existing ? Number(existing.targetAmount) : undefined);

    // Due date: inferred → existing → floor. Clamp anything too soon up
    // to the floor so a happy-path submit can't fail the server refine.
    let dueDate =
      args.defaults.due_date ??
      (existing ? existing.dueDate.toISOString().slice(0, 10) : undefined);
    if (!dueDate || !isDueDateAtLeastOneMonth(dueDate)) {
      dueDate = floorDateStr();
    }

    const defaults: FormDefaults = {};
    if (title !== undefined) defaults.title = title;
    if (targetNum !== undefined) defaults.target_amount = targetNum.toFixed(2);
    defaults.due_date = dueDate;

    // Intent stores args matching the target tool's snake_case schema.
    // mode "update" binds to updateGoal (carries goal_id); "add" binds
    // to addGoal.
    const mode: "add" | "update" = args.goal_id ? "update" : "add";
    const initialArgs: Record<string, unknown> = {};
    if (mode === "update") initialArgs.goal_id = args.goal_id;
    if (title !== undefined) initialArgs.title = title;
    if (targetNum !== undefined) initialArgs.target_amount = targetNum;
    initialArgs.due_date = dueDate;

    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      {
        tool: mode === "update" ? "updateGoal" : "addGoal",
        args: initialArgs,
        skipStrictValidate: true,
      },
    );

    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: ctx.workspaceId },
      select: { currency: true },
    });

    return {
      block: {
        type: "goal_form_card",
        question: args.question,
        intent_id: out.intent.id,
        defaults,
        currency: workspace.currency,
        mode,
      },
    };
  },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec nx test api -- chat.tools.present-goal-form`
Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/present-goal-form.ts apps/api/tests/chat.tools.present-goal-form.test.ts
git commit -m "feat(chat): presentGoalForm presenter -> goal_form_card

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Register tools in REGISTRY + prompt routing

**Files:**
- Modify: `apps/api/src/chat/tools/index.ts`
- Modify: `apps/api/src/chat/turn.ts`
- Test: `apps/api/tests/chat.tools.registry.test.ts` (existing — must still pass)

- [ ] **Step 1: Import and register the 6 tools in `REGISTRY`**

In `apps/api/src/chat/tools/index.ts`, add the imports after the `pauseDailyBrief` import:

```ts
import { pauseDailyBrief } from "./pause-daily-brief.js";
import { listGoals } from "./list-goals.js";
import { getGoalDetails } from "./get-goal-details.js";
import { presentGoalForm } from "./present-goal-form.js";
import { addGoal } from "./add-goal.js";
import { updateGoal } from "./update-goal.js";
import { archiveGoal } from "./archive-goal.js";
```

Add to the `REGISTRY` array before the closing `];`:

```ts
  pauseDailyBrief as ToolDef,
  listGoals as ToolDef,
  getGoalDetails as ToolDef,
  presentGoalForm as ToolDef,
  addGoal as ToolDef,
  updateGoal as ToolDef,
  archiveGoal as ToolDef,
];
```

- [ ] **Step 2: Add goals routing to the system prompt**

In `apps/api/src/chat/turn.ts`, find the recurring/budget routing bullets in the prompt template literal (around lines 136–208, the section listing `getBudget`, `listRecurring`, `presentRecurringForm`). Add a goals block alongside them (insert after the recurring routing bullets, before the generic write-tools paragraph that starts "For write tools"):

```ts
- "Goals" / "목표" / "저축 목표" / "내 목표" → listGoals. It renders a goals
  card with each goal's progress, percent bar, and D-day. NOTE: savings
  accrue AUTOMATICALLY from staying under budget in a goal's categories —
  there is NO manual deposit. Never tell the user to "add money" to a goal.
- "X 목표 자세히" / "show my Japan goal" / a specific goal by name →
  getGoalDetails with title set to a word from the name (or goal_id from a
  prior card). If it returns ambiguous=true, call listGoals to show the
  picker — do NOT ask "which one?".
- "목표 만들어/추가" / "create a goal" / "여행자금 200만원 목표" → presentGoalForm
  with whatever title/target_amount/due_date you can infer in defaults. The
  form collects the rest and submits. Goals are Pro-only; presentGoalForm
  returns a short upgrade message for non-Pro users.
- Edit a goal ("그 목표 300만원으로 늘려줘", "change the target") →
  presentConfirmCard with accept_action { tool: "updateGoal", args: { goal_id,
  target_amount, ... } } OR presentGoalForm with goal_id for a fuller edit.
- Archive a goal ("그 목표 보관해줘", "archive my Japan goal") →
  presentConfirmCard with accept_action { tool: "archiveGoal", args: { goal_id } }.
- Generating/editing a savings STRATEGY is screen-only — tell the user to tap
  the goal card to open the goal screen; do NOT try to generate it in chat.
```

- [ ] **Step 3: Run the registry test + typecheck**

Run: `pnpm exec nx test api -- chat.tools.registry`
Expected: PASS (the registry stays internally consistent — unique names, valid ToolDefs).

Run: `pnpm exec nx typecheck api`
Expected: PASS.

- [ ] **Step 4: Run the full api chat tool suite to confirm nothing regressed**

Run: `pnpm exec nx test api -- chat.tools`
Expected: PASS (all chat tool tests, including the 5 new goals test files).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/chat/tools/index.ts apps/api/src/chat/turn.ts
git commit -m "feat(chat): register goals tools + prompt routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: Mobile — `GoalsListBlock` + `GoalDetailBlock` (read cards)

**Files:**
- Create: `apps/mobile/src/chat/blocks/GoalsListBlock.tsx`
- Create: `apps/mobile/src/chat/blocks/GoalDetailBlock.tsx`
- Modify: `apps/mobile/src/chat/PresentationBlock.tsx`
- Modify: `apps/mobile/src/chat/ThreadView.tsx` (`isCardBlock`)

- [ ] **Step 1: Create `GoalsListBlock`**

Create `apps/mobile/src/chat/blocks/GoalsListBlock.tsx` (mirrors `BudgetListBlock` — whole card taps to the goals tab, chevron header, per-row progress bar):

```tsx
import { View, Text, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty, currencySymbol, CategoryIcon } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "goals_list" }>;
type Props = { block: Block };

export function GoalsListBlock({ block }: Props) {
  const sym = currencySymbol(block.currency);
  return (
    <Pressable
      onPress={() => router.push("/goals" as never)}
      accessibilityRole="button"
      accessibilityLabel="Open goals"
      style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
    >
      <BlockCard>
        <BlockHeader title={block.title} chevron />
        {block.rows.length === 0 ? (
          <BlockEmpty text="No goals yet." />
        ) : (
          <View style={{ marginTop: space.xs }}>
            {block.rows.map((r, i) => {
              const pct = Math.max(0, Math.min(100, r.bar_pct));
              return (
                <View key={r.id} style={[styles.row, i < block.rows.length - 1 && styles.rowBorder]}>
                  <View style={styles.line}>
                    <View style={styles.titleWrap}>
                      <CategoryIcon icon={r.icon} color={r.color} size={14} />
                      <Text style={styles.name} numberOfLines={1}>{r.title}</Text>
                    </View>
                    <Text style={styles.due}>{r.due_label}</Text>
                  </View>
                  <View style={styles.line}>
                    <Text style={[styles.amount, r.over && { color: colors.up }]}>
                      {sym}{r.saved} / {sym}{r.target}
                    </Text>
                    <Text style={styles.pct}>{Math.round(r.bar_pct)}%</Text>
                  </View>
                  <View style={styles.track}>
                    <View style={[styles.fill, { width: `${pct}%`, backgroundColor: r.color ?? colors.primary }]} />
                  </View>
                </View>
              );
            })}
          </View>
        )}
        {block.footer ? <BlockFooter text={block.footer} /> : null}
      </BlockCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 10, gap: 6 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  titleWrap: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500", flex: 1, minWidth: 0 },
  due: { ...type$.caption, color: colors.muted, fontVariant: ["tabular-nums"] },
  amount: { ...type$.bodySm, color: colors.body, fontVariant: ["tabular-nums"] },
  pct: { ...type$.caption, color: colors.muted },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.hairline, overflow: "hidden" },
  fill: { height: "100%" },
});
```

- [ ] **Step 2: Create `GoalDetailBlock`**

Create `apps/mobile/src/chat/blocks/GoalDetailBlock.tsx` (mirrors `BudgetListBlock`'s headline + `TransactionDetailBlock`'s tap-to-screen; renders allocations + note):

```tsx
import { View, Text, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, currencySymbol, CategoryIcon } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "goal_detail" }>;
type Props = { block: Block };

export function GoalDetailBlock({ block }: Props) {
  const sym = currencySymbol(block.currency);
  const pct = Math.max(0, Math.min(100, block.bar_pct));
  return (
    <Pressable
      onPress={() => router.push(`/goals/${block.id}` as never)}
      accessibilityRole="button"
      accessibilityLabel={`Open goal ${block.title}`}
      style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
    >
      <BlockCard>
        <BlockHeader title={block.title} chevron subtitle={block.due_label} />
        <View style={styles.headline}>
          <Text style={styles.heroAmount}>{sym}{block.saved}</Text>
          <Text style={styles.heroCap}>of {sym}{block.target}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.pct}>{Math.round(block.bar_pct)}%</Text>
            {typeof block.days_left === "number" ? (
              <Text style={styles.left}>
                {block.days_left >= 0 ? `${block.days_left} days left` : `${-block.days_left} days overdue`}
              </Text>
            ) : null}
          </View>
        </View>

        {block.allocations && block.allocations.length > 0 ? (
          <View style={styles.allocs}>
            <Text style={styles.allocsLabel}>Savings plan</Text>
            {block.allocations.map((a, i) => (
              <View key={`${a.category.name}-${i}`} style={styles.allocRow}>
                <View style={styles.allocLeft}>
                  <CategoryIcon icon={a.category.icon} color={a.category.color} size={14} />
                  <Text style={styles.allocName} numberOfLines={1}>{a.category.name}</Text>
                </View>
                <Text style={styles.allocAmount}>{sym}{a.monthly}/mo</Text>
              </View>
            ))}
          </View>
        ) : null}

        {block.note ? <Text style={styles.note}>{block.note}</Text> : null}
        {block.strategy_note ? <BlockFooter text={block.strategy_note} /> : null}
      </BlockCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headline: { gap: 4, paddingVertical: space.xs },
  heroAmount: { fontSize: 28, lineHeight: 34, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  heroCap: { ...type$.bodySm, color: colors.muted },
  metaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pct: { ...type$.caption, color: colors.muted },
  left: { ...type$.caption, color: colors.primary, fontWeight: "600" },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.hairline, overflow: "hidden" },
  fill: { height: "100%" },
  allocs: { marginTop: space.sm, gap: 6 },
  allocsLabel: { ...type$.caption, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  allocRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  allocLeft: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 },
  allocName: { ...type$.bodySm, color: colors.ink, flex: 1, minWidth: 0 },
  allocAmount: { ...type$.bodySm, color: colors.body, fontVariant: ["tabular-nums"] },
  note: { ...type$.caption, color: colors.muted, marginTop: space.sm, fontStyle: "italic" },
});
```

- [ ] **Step 3: Wire both into `PresentationBlock.tsx`**

In `apps/mobile/src/chat/PresentationBlock.tsx`, add the imports after the `CategoryListBlock` import:

```ts
import { CategoryListBlock } from "./blocks/CategoryListBlock";
import { GoalsListBlock } from "./blocks/GoalsListBlock";
import { GoalDetailBlock } from "./blocks/GoalDetailBlock";
```

Add the render branches before the `const _exhaustive: never = block;` line:

```tsx
  if (block.type === "category_list") {
    return <CategoryListBlock block={block} />;
  }
  if (block.type === "goals_list") {
    return <GoalsListBlock block={block} />;
  }
  if (block.type === "goal_detail") {
    return <GoalDetailBlock block={block} />;
  }
```

- [ ] **Step 4: Add both to `isCardBlock`**

In `apps/mobile/src/chat/ThreadView.tsx`, add to the `isCardBlock` boolean (before the closing `)`):

```ts
    b.type === "category_list" ||
    b.type === "goals_list" ||
    b.type === "goal_detail"
  );
```

- [ ] **Step 5: Typecheck mobile**

Run: `pnpm exec nx typecheck mobile`
Expected: PASS (only the pre-existing `restore.tsx` / `iap/client.ts` errors from the separate IAP work stream remain, if any — no NEW errors from these files). The `goal_form_card` member of the union is not yet rendered, so the `_exhaustive: never` cast in `PresentationBlock.tsx` WILL error until Task 10 adds it. That is expected here — Task 10 closes it. To keep this task green on its own, complete Step 6 of THIS task does not include the form; therefore the never-cast error is expected and resolved in Task 10. Note this in the commit and proceed.

  > Implementer note: if the `_exhaustive` error blocks the typecheck, it is acceptable for THIS task's typecheck to surface exactly one error — the unhandled `goal_form_card` — which Task 10 resolves. Do not suppress it with a cast.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/chat/blocks/GoalsListBlock.tsx apps/mobile/src/chat/blocks/GoalDetailBlock.tsx apps/mobile/src/chat/PresentationBlock.tsx apps/mobile/src/chat/ThreadView.tsx
git commit -m "feat(mobile/chat): GoalsListBlock + GoalDetailBlock read cards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Mobile — `GoalFormBlock` (form card)

**Files:**
- Create: `apps/mobile/src/chat/blocks/GoalFormBlock.tsx`
- Modify: `apps/mobile/src/chat/PresentationBlock.tsx`
- Modify: `apps/mobile/src/chat/ThreadView.tsx` (`isCardBlock`)

- [ ] **Step 1: Create `GoalFormBlock`**

Create `apps/mobile/src/chat/blocks/GoalFormBlock.tsx` (mirrors `RecurringFormBlock`: title + amount + date inputs, submit/cancel, post-submit done row; submit overrides use the snake_case keys the `addGoal`/`updateGoal` tools expect — `title`, `target_amount`, `due_date`; the date picker enforces the same 1-month floor as the server):

```tsx
import { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { PresentationBlock } from "@fina/shared";
import { minDueDateOneMonthUTC } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { useDatePickerSheet } from "../../datetime/DatePickerSheetHost";
import { BlockCard, currencySymbol } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "goal_form_card" }>;

type Props = {
  block: Block;
  onSubmit: (intentId: string, overrides: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
  onFocusChange?: (focused: boolean) => void;
};

const AMOUNT_RE = /^\d+(\.\d{0,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEN_YEARS_MS = 10 * 365 * 24 * 60 * 60 * 1000;

function floorDateStr(): string {
  return minDueDateOneMonthUTC().toISOString().slice(0, 10);
}

export function GoalFormBlock({ block, onSubmit, onCancel, onFocusChange }: Props) {
  const datePicker = useDatePickerSheet();
  const sym = currencySymbol(block.currency);
  const [title, setTitle] = useState<string>(block.defaults.title ?? "");
  const [amount, setAmount] = useState<string>(block.defaults.target_amount ?? "");
  const [dateStr, setDateStr] = useState<string>(block.defaults.due_date ?? floorDateStr());
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);

  useEffect(() => {
    onFocusChange?.(inputFocused);
    return () => onFocusChange?.(false);
  }, [inputFocused, onFocusChange]);

  const titleValid = title.trim().length > 0 && title.trim().length <= 80;
  const amountValid = amount.length > 0 && AMOUNT_RE.test(amount) && parseFloat(amount) > 0;
  // Mirror the server floor: due date must be >= one month from today.
  const dateValid = DATE_RE.test(dateStr) && dateStr >= floorDateStr();
  const canSubmit = !submitting && !done && titleValid && amountValid && dateValid;

  const dateValue = useMemo(() => {
    if (!DATE_RE.test(dateStr)) return new Date();
    const [y, mo, d] = dateStr.split("-").map(Number) as [number, number, number];
    return new Date(Date.UTC(y, mo - 1, d, 12));
  }, [dateStr]);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const overrides: Record<string, unknown> = {
        title: title.trim(),
        target_amount: parseFloat(amount),
        due_date: dateStr,
      };
      await onSubmit(block.intent_id, overrides);
      setDone(true);
    } catch (e) {
      const code = (e as { code?: string }).code;
      Alert.alert(
        "Couldn't save",
        code === "intent_gone"
          ? "This form expired. Ask Fina to set it up again."
          : code ?? "Try again in a moment.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = () => {
    if (submitting || done) return;
    onCancel();
    setCancelled(true);
  };

  if (done) {
    return (
      <BlockCard>
        <View style={styles.doneRow}>
          <View style={styles.doneCheck}>
            <Ionicons name="checkmark" size={16} color={colors.onPrimary} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.doneName}>{title.trim()}</Text>
            <Text style={styles.doneMeta} numberOfLines={1}>By {dateStr}</Text>
          </View>
          <Text style={styles.doneAmount}>{sym}{formatAmount(amount)}</Text>
        </View>
      </BlockCard>
    );
  }
  if (cancelled) {
    return (
      <BlockCard>
        <Text style={styles.cancelledText}>{title.trim() || block.defaults.title || "Goal"} — cancelled</Text>
      </BlockCard>
    );
  }

  return (
    <BlockCard>
      <View style={styles.field}>
        <Text style={styles.label}>Goal</Text>
        <TextInput
          style={[styles.input, styles.nameInput]}
          value={title}
          onChangeText={setTitle}
          editable={!submitting}
          maxLength={80}
          autoCapitalize="sentences"
          returnKeyType="done"
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Target</Text>
        <View style={styles.amountRow}>
          <Text style={styles.amountPrefix}>{sym}</Text>
          <TextInput
            style={[styles.input, styles.amountInput]}
            value={amount}
            onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ""))}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor={colors.muted}
            editable={!submitting}
            returnKeyType="done"
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          />
        </View>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Target date</Text>
        <Pressable
          style={styles.dateBtn}
          onPress={() => {
            if (submitting) return;
            datePicker.open(
              dateValue,
              (next) => {
                const y = next.getUTCFullYear();
                const mo = String(next.getUTCMonth() + 1).padStart(2, "0");
                const d = String(next.getUTCDate()).padStart(2, "0");
                setDateStr(`${y}-${mo}-${d}`);
              },
              { minimumDate: minDueDateOneMonthUTC(), maximumDate: new Date(Date.now() + TEN_YEARS_MS) },
            );
          }}
        >
          <Text style={styles.dateBtnText}>{dateStr || "Pick a date"}</Text>
        </Pressable>
      </View>

      <View style={styles.actions}>
        <Pressable style={[styles.btn, styles.btnCancel]} onPress={cancel} disabled={submitting}>
          <Text style={styles.btnCancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnSubmit, !canSubmit && styles.btnDisabled]}
          onPress={submit}
          disabled={!canSubmit}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.onPrimary} />
          ) : (
            <Text style={styles.btnSubmitText}>{block.mode === "update" ? "Update" : "Add goal"}</Text>
          )}
        </Pressable>
      </View>
    </BlockCard>
  );
}

function formatAmount(s: string): string {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n.toFixed(2) : s;
}

const styles = StyleSheet.create({
  field: { marginTop: space.sm },
  label: { ...type$.caption, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: 4 },
  amountRow: { flexDirection: "row", alignItems: "center", backgroundColor: colors.surfaceSoft, borderRadius: 10, paddingHorizontal: 12 },
  amountPrefix: { ...type$.bodyMd, color: colors.muted, marginRight: 4 },
  amountInput: { flex: 1 },
  input: { paddingVertical: 10, color: colors.ink, fontSize: 16 },
  nameInput: { backgroundColor: colors.surfaceSoft, borderRadius: 10, paddingHorizontal: 12 },
  dateBtn: { paddingVertical: 12, paddingHorizontal: 12, backgroundColor: colors.surfaceSoft, borderRadius: 10 },
  dateBtnText: { ...type$.bodyMd, color: colors.ink },
  actions: { flexDirection: "row", gap: space.xs, marginTop: space.base },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 999, alignItems: "center" },
  btnCancel: { backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.hairline },
  btnSubmit: { backgroundColor: colors.primary },
  btnDisabled: { backgroundColor: colors.primaryDisabled },
  btnCancelText: { ...type$.button, color: colors.ink },
  btnSubmitText: { ...type$.button, color: colors.onPrimary },
  doneRow: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 4 },
  doneCheck: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  doneName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  doneMeta: { ...type$.caption, color: colors.muted, marginTop: 2 },
  doneAmount: { ...type$.bodyMd, color: colors.ink, fontVariant: ["tabular-nums"], fontWeight: "500" },
  cancelledText: { ...type$.bodySm, color: colors.muted, fontStyle: "italic" },
});
```

- [ ] **Step 2: Wire `GoalFormBlock` into `PresentationBlock.tsx`**

Add the import:

```ts
import { GoalFormBlock } from "./blocks/GoalFormBlock";
```

Add the render branch before `const _exhaustive: never = block;` (mirror the `recurring_form_card` wiring exactly — same `onSubmitForm` / `onReject` / `onFormFocusChange` handlers):

```tsx
  if (block.type === "goal_form_card") {
    return (
      <GoalFormBlock
        block={block}
        onSubmit={async (id, overrides) => {
          if (onSubmitForm) await onSubmitForm(id, overrides);
        }}
        onCancel={() => onReject?.(undefined)}
        {...(onFormFocusChange ? { onFocusChange: onFormFocusChange } : {})}
      />
    );
  }
```

- [ ] **Step 3: Add `goal_form_card` to `isCardBlock`**

In `apps/mobile/src/chat/ThreadView.tsx`:

```ts
    b.type === "goals_list" ||
    b.type === "goal_detail" ||
    b.type === "goal_form_card"
  );
```

- [ ] **Step 4: Typecheck mobile (must be fully clean now)**

Run: `pnpm exec nx typecheck mobile`
Expected: PASS — the `_exhaustive: never` cast in `PresentationBlock.tsx` now compiles (all three goal block types handled). Only the pre-existing IAP-stream errors (`restore.tsx`, `iap/client.ts`), if any, remain — no errors from the chat/goals files.

- [ ] **Step 5: Verify `DatePickerSheet` accepts `minimumDate`**

The `GoalFormBlock` date picker passes `{ minimumDate: ..., maximumDate: ... }`. Confirm the `useDatePickerSheet().open(value, onPick, opts)` options type accepts `minimumDate` (the recurring form passes `maximumDate` only). Run:

Run: `grep -n "minimumDate\|maximumDate\|type.*Options\|open(" apps/mobile/src/datetime/DatePickerSheetHost.tsx`
Expected: the options type includes both `minimumDate?` and `maximumDate?`. If `minimumDate` is NOT supported, add it to the options type + pass it through to the underlying picker in `DatePickerSheetHost.tsx` (and `DatePickerSheet.tsx`), then re-run the mobile typecheck. (Do not edit any IAP-stream file in the process.)

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/chat/blocks/GoalFormBlock.tsx apps/mobile/src/chat/PresentationBlock.tsx apps/mobile/src/chat/ThreadView.tsx
git commit -m "feat(mobile/chat): GoalFormBlock add/update goal form

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(If Step 5 required editing `DatePickerSheetHost.tsx` / `DatePickerSheet.tsx`, add those files to this commit too — but note `DatePickerSheet.tsx` already has uncommitted IAP-stream changes per `git status`; if so, do NOT `git add` that file wholesale. Instead add only your `minimumDate` hunk via `git add -p apps/mobile/src/datetime/DatePickerSheet.tsx`, or coordinate by leaving that file alone and supporting `minimumDate` purely in `DatePickerSheetHost.tsx`. Prefer the latter to avoid touching the IAP working tree.)

---

## Final verification (after all tasks)

- [ ] Run the full api suite: `pnpm exec nx test api`
  Expected: PASS (no regressions; the 5 new goals test files + existing goals route tests green).
- [ ] Run the mobile typecheck: `pnpm exec nx typecheck mobile`
  Expected: PASS (no new errors).
- [ ] Build shared: `pnpm exec nx build shared` — clean.
- [ ] Dispatch the final whole-implementation code reviewer (per subagent-driven-development), then use superpowers:finishing-a-development-branch.

---

## Manual test scenarios (mobile, after merge)

For a **Pro** user (trial active or paid):
1. "내 목표 보여줘" → `goals_list` card; tap → goals tab.
2. "일본여행 목표 자세히" → `goal_detail` card with progress + savings-plan allocations + the auto-savings note; tap → goal detail screen.
3. Ambiguous title ("여행 목표 보여줘" with two "여행…" goals) → assistant shows the `goals_list` picker, does NOT ask "which one?".
4. "여행자금 200만원 목표 만들어줘" → `goal_form_card` (mode add) prefilled; the date defaults to ≥ 1 month; submit → "Created goal …" confirmation.
5. "그 목표 300만원으로 늘려줘" → confirm card → on accept, "Updated goal …".
6. "그 목표 보관해줘" → confirm card → on accept, "Archived goal …"; it disappears from `listGoals`.

For a **non-Pro** user (trial expired, no sub):
7. "목표 보여줘" still works (reads are open to all tiers).
8. "목표 만들어줘" → `presentGoalForm` returns the short "Goals are a Pro feature" text (no form).
9. A direct `addGoal`/`updateGoal`/`archiveGoal` (e.g. via a stale confirm card) → `upgrade_required`.

---

## Self-Review

**Spec coverage:**
- 5 tools (the spec's `presentGoalForm` + `addGoal`/`updateGoal`/`archiveGoal` make 6 tool files; the spec counts presentGoalForm as a presenter) → Tasks 3–7. ✓
- 3 block types + `goal_not_found` + shared due-date predicate → Task 1. ✓
- Goals service extraction with Pro gate, no `withWorkspaceLock`, behavior-preserving routes → Task 2. ✓
- Title resolution as a NEW helper (`findGoalsByTitle`, substring insensitive, archived excluded, 0→`goal_not_found`, 1→detail, >1→`{ambiguous:true}`) → Task 4. ✓
- Pro tier gate on writes + `presentGoalForm` short-circuit → Tasks 2/5/6/7. ✓
- due_date floor clamp in `presentGoalForm`, refine re-validated at consume via tool `args` → Tasks 5/7. ✓
- `target_amount` string in block / number in intent arg → Tasks 1/7. ✓
- CONFIRMABLE_TOOLS / AUDIT_WRITE_TOOLS / TARGET_TYPE_MAP(`goal`) / extractTargetId(`r.goal?.id`) / confirmationFor → Tasks 5/6. ✓
- Mobile `GoalsListBlock`/`GoalDetailBlock`/`GoalFormBlock` + PresentationBlock + isCardBlock + tap → `/goals`,`/goals/{id}` → Tasks 9/10. ✓
- turn.ts prompt routing, "savings automatic, no manual deposit" → Task 8. ✓
- Tests: list/detail/ambiguous/0/archived/tier-gate/min-due-date → Tasks 3–7. ✓
- Out of scope (strategy gen in chat, manual savedAmount, allocation editing, web) → not built. ✓

**Type consistency:** Block field names (`saved`/`target`/`bar_pct`/`due_label`/`days_left`/`note`/`strategy_note`/`monthly`/`target_amount`/`due_date`) are identical between the DTO (Task 1), the API producers (Tasks 3/4/7), and the mobile consumers (Tasks 9/10). The form submit override keys (`title`/`target_amount`/`due_date`/`goal_id`) match the `addGoal`/`updateGoal` zod schemas (Tasks 5/6). `dDayLabel`/`daysLeft` are defined once in `list-goals.ts` and imported by `get-goal-details.ts`. The service functions (`listGoalsWithSavings`/`getGoalWithSavings`/`findGoalsByTitle`/`createGoalService`/`patchGoalService`) keep the same names across Tasks 2–7.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the one expected-intermediate typecheck error (Task 9 Step 5) is explicitly explained and resolved in Task 10.
