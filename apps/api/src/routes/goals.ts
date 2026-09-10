import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { CreateGoalBody, isPaidFeatureTier, PatchGoalBody } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, registerPersonalWorkspaceGate, requireWorkspaceContext } from "../auth/context.js";
import { generateAndStoreGoalStrategy } from "../goals/generate-strategy.js";
import { computeGoalSavings } from "../goals/savings.js";
import { effectiveTier } from "../auth/tier.js";
import { logger } from "../logger.js";
import {
  listGoalsWithSavings,
  getGoalWithSavings,
  createGoalService,
  patchGoalService,
} from "../goals/service.js";

type GoalRow = {
  id: string;
  title: string;
  description: string | null;
  targetAmount: Prisma.Decimal;
  savedAmount: Prisma.Decimal;
  dueDate: Date;
  icon: string | null;
  color: string | null;
  strategy: Prisma.JsonValue;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  allocations: Array<{
    categoryId: string;
    monthlyAmount: Prisma.Decimal;
    rationale: string | null;
    category: { name: string; icon: string | null; color: string | null };
  }>;
};

/** Build the wire DTO. `computedSaved` overrides the stored amount —
 *  goal savings are derived from actual under-budget behavior per the
 *  goal's allocations (see goals/savings.ts), not from manual input. */
function dto(g: GoalRow, computedSaved: number): unknown {
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    targetAmount: g.targetAmount.toFixed(2),
    savedAmount: computedSaved.toFixed(2),
    dueDate: g.dueDate.toISOString().slice(0, 10),
    icon: g.icon,
    color: g.color,
    strategy: g.strategy,
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

const goalInclude = {
  allocations: {
    include: {
      category: { select: { name: true, icon: true, color: true } },
    },
    orderBy: { monthlyAmount: "desc" as const },
  },
};

export async function goalsRoutes(app: FastifyInstance): Promise<void> {
  registerPersonalWorkspaceGate(app, { allowGet: true });
  app.get("/workspaces/:id/goals", async (req, reply) => {
    const params = req.params as { id: string };
    const q = req.query as { includeArchived?: string };
    const includeArchived = q.includeArchived === "true";
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const asOf = new Date();
      if (includeArchived) {
        const rows = await prisma.goal.findMany({
          where: { workspaceId: ctx.membership.workspaceId },
          orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
          include: goalInclude,
        });
        const goals = await Promise.all(
          rows.map(async (g) =>
            dto(g, await computeGoalSavings(ctx.membership.workspaceId, g.id, { asOf })),
          ),
        );
        return { goals };
      }
      const goals = await listGoalsWithSavings(ctx.membership.workspaceId, asOf);
      if (process.env.DEBUG_GOAL_SAVINGS === "1") {
        logger.info(
          {
            action: "listGoalsWithSavings.response",
            workspaceId: ctx.membership.workspaceId,
            includeArchived,
            asOf: asOf.toISOString(),
            count: goals.length,
          },
          "Goal endpoint debug",
        );
      }
      return { goals };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get<{ Params: { id: string; goalId: string } }>(
    "/workspaces/:id/goals/:goalId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (req.params.id !== ctx.membership.workspaceId) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const asOf = new Date();
      const goal = await getGoalWithSavings(
          ctx.membership.workspaceId,
          req.params.goalId,
          asOf,
        );
        if (!goal) return reply.code(404).send({ error: "not_found" });
        if (process.env.DEBUG_GOAL_SAVINGS === "1") {
          logger.info(
            {
              action: "getGoalWithSavings.response",
              workspaceId: ctx.membership.workspaceId,
              goalId: req.params.goalId,
              asOf: asOf.toISOString(),
              savedAmount: goal.savedAmount,
            },
            "Goal endpoint debug",
          );
        }
        return { goal };
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        throw e;
      }
    },
  );

  app.post("/workspaces/:id/goals", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = CreateGoalBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (!isPaidFeatureTier(tier.tier)) {
        return reply.code(402).send({ error: "upgrade_required" });
      }
      const goal = await createGoalService(
        ctx.membership.workspaceId,
        ctx.session.userId,
        parsed.data,
      );
      // Fire-and-forget LLM strategy generation. The user gets an
      // immediate 201; the detail screen refetches and picks up the
      // strategy once the LLM returns.
      void generateAndStoreGoalStrategy(app.fina.env, goal.id).catch(() => {});
      return reply.code(201).send({ goal });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

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

  app.post<{ Params: { id: string; goalId: string } }>(
    "/workspaces/:id/goals/:goalId/strategy",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const asOf = new Date();
        const tier = await effectiveTier(ctx.session.userId);
        if (!isPaidFeatureTier(tier.tier)) {
          return reply.code(402).send({ error: "upgrade_required" });
        }
        const row = await prisma.goal.findFirst({
          where: { id: req.params.goalId, workspaceId: ctx.membership.workspaceId },
          select: { id: true },
        });
        if (!row) return reply.code(404).send({ error: "not_found" });
        // Wait for generation to complete (small + bounded) so the
        // caller can refresh once and see the new plan.
        await generateAndStoreGoalStrategy(app.fina.env, row.id);
        const goal = await getGoalWithSavings(ctx.membership.workspaceId, row.id, asOf);
        if (!goal) return reply.code(404).send({ error: "not_found" });
        return reply.code(200).send({ goal });
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        throw e;
      }
    },
  );

  app.delete<{ Params: { id: string; goalId: string } }>(
    "/workspaces/:id/goals/:goalId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const result = await prisma.goal.deleteMany({
          where: { id: req.params.goalId, workspaceId: ctx.membership.workspaceId },
        });
        if (result.count === 0) return reply.code(404).send({ error: "not_found" });
        return reply.code(204).send();
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        throw e;
      }
    },
  );
}
