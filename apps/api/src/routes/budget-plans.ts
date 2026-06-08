import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isPaidFeatureTier } from "@fina/shared";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import {
  type BudgetPlanRecord,
  getDefaultBudget,
  setDefaultBudget,
  getOrSnapshotMonthBudget,
  setMonthBudget,
  monthlySpendByCategory,
  monthlyTotalSpend,
  monthlyScheduledByCategory,
  monthlyScheduledTotal,
  recentMonthlyAvgSpend,
  type CategoryAllocation,
  type SetBudgetInput,
} from "../budget-plans/service.js";
import { suggestBudgetSplit } from "../budget-plans/suggest-split.js";

const MAX_TOTAL = 9_999_999.99;

const Allocation = z.object({
  categoryId: z.string().min(1),
  amount: z.number().min(0).max(MAX_TOTAL),
});

const SetBudgetBody = z.object({
  totalAmount: z.number().positive().max(MAX_TOTAL),
  categoryAllocations: z.array(Allocation).optional(),
  /** Whether saving the default should also overwrite the current
   *  month's snapshot. UX-level decision — the user picks at save
   *  time via an Alert. */
  scope: z.enum(["default_only", "default_and_current"]).optional(),
});

const SuggestBody = z.object({
  totalAmount: z.number().positive().max(MAX_TOTAL),
});

function toSetBudgetInput(data: z.infer<typeof SetBudgetBody>): SetBudgetInput {
  return {
    totalAmount: data.totalAmount,
    ...(data.categoryAllocations ? { categoryAllocations: data.categoryAllocations } : {}),
  };
}

function currentYM(): { year: number; month: number } {
  // Use UTC for now — Plaid sync + transactions use UTC noon anchors.
  // Workspace-tz-aware month boundaries can come later if it matters.
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function parseYearMonth(s: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return { year, month };
}

export async function budgetPlansRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/budget-plans/default", async (req, reply) => {
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if ((req.params as { id: string }).id !== ctx.membership.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const [plan, recentAvg] = await Promise.all([
        getDefaultBudget(ctx.membership.workspaceId),
        recentMonthlyAvgSpend(ctx.membership.workspaceId),
      ]);
      return { plan, recentMonthlyAvgSpend: recentAvg };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post("/workspaces/:id/budget-plans/default", async (req, reply) => {
    const parsed = SetBudgetBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if ((req.params as { id: string }).id !== ctx.membership.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const budgetInput = toSetBudgetInput(parsed.data);
      const plan = await setDefaultBudget(ctx.membership.workspaceId, budgetInput);
      // When the user opted to push the new default into the current
      // month too, overwrite that month's snapshot with the same values.
      if (parsed.data.scope === "default_and_current") {
        const { year, month } = currentYM();
        await setMonthBudget(ctx.membership.workspaceId, year, month, budgetInput);
      }
      return reply.code(200).send({ plan });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  /** Returns the budget for the current calendar month — snapshotting
   *  from the default if no row yet exists. Also returns spend totals
   *  so the UI can render progress without a second request. */
  app.get("/workspaces/:id/budget-plans/current", async (req, reply) => {
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if ((req.params as { id: string }).id !== ctx.membership.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const { year, month } = currentYM();
      const plan = await getOrSnapshotMonthBudget(
        ctx.membership.workspaceId,
        year,
        month,
      );
      const [byCategory, totalSpent, scheduledByCat, totalScheduled] =
        await Promise.all([
          monthlySpendByCategory(ctx.membership.workspaceId, year, month),
          monthlyTotalSpend(ctx.membership.workspaceId, year, month),
          monthlyScheduledByCategory(ctx.membership.workspaceId, year, month),
          monthlyScheduledTotal(ctx.membership.workspaceId, year, month),
        ]);
      return reply.code(200).send({
        yearMonth: `${year}-${String(month).padStart(2, "0")}`,
        plan,
        spendByCategory: byCategory,
        totalSpent: totalSpent.toFixed(2),
        scheduledByCategory: scheduledByCat,
        totalScheduled: totalScheduled.toFixed(2),
      });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post<{ Params: { id: string; yearMonth: string } }>(
    "/workspaces/:id/budget-plans/months/:yearMonth",
    async (req, reply) => {
      const ym = parseYearMonth(req.params.yearMonth);
      if (!ym) return reply.code(400).send({ error: "invalid_year_month" });
      const parsed = SetBudgetBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const plan = await setMonthBudget(
          ctx.membership.workspaceId,
          ym.year,
          ym.month,
          toSetBudgetInput(parsed.data),
        );
        return reply.code(200).send({ plan });
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        throw e;
      }
    },
  );

  /** Paid-tier: ask Fina to split a given total across categories
   *  based on the user's last-90-day spending mix. */
  app.post("/workspaces/:id/budget-plans/suggest-split", async (req, reply) => {
    const parsed = SuggestBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if ((req.params as { id: string }).id !== ctx.membership.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (!isPaidFeatureTier(tier.tier)) {
        return reply.code(402).send({ error: "upgrade_required" });
      }
      const result = await suggestBudgetSplit(
        app.fina.env,
        ctx.membership.workspaceId,
        parsed.data.totalAmount,
      );
      return reply.code(200).send(result);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}

// Re-export so other modules (mobile DTO) can import the same shapes
// without depending on Prisma types.
export type { BudgetPlanRecord, CategoryAllocation };
