import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { CreateGoalBody, PatchGoalBody } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { generateAndStoreGoalStrategy } from "../goals/generate-strategy.js";
import { computeGoalSavings } from "../goals/savings.js";

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

function dateOnly(s: string): Date {
  // YYYY-MM-DD → UTC noon, same convention as transactions.
  return new Date(`${s}T12:00:00.000Z`);
}

export async function goalsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/goals", async (req, reply) => {
    const params = req.params as { id: string };
    const q = req.query as { includeArchived?: string };
    const includeArchived = q.includeArchived === "true";
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const rows = await prisma.goal.findMany({
        where: {
          workspaceId: ctx.membership.workspaceId,
          ...(includeArchived ? {} : { archivedAt: null }),
        },
        // Soonest due first — matches the design's "list sorted by due date".
        orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
        include: goalInclude,
      });
      const goals = await Promise.all(
        rows.map(async (g) => {
          const saved = await computeGoalSavings(
            ctx.membership.workspaceId,
            g.id,
          );
          return dto(g, saved);
        }),
      );
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
        const row = await prisma.goal.findFirst({
          where: {
            id: req.params.goalId,
            workspaceId: ctx.membership.workspaceId,
          },
          include: goalInclude,
        });
        if (!row) return reply.code(404).send({ error: "not_found" });
        const saved = await computeGoalSavings(
          ctx.membership.workspaceId,
          row.id,
        );
        return { goal: dto(row, saved) };
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
      const created = await prisma.goal.create({
        data: {
          workspaceId: ctx.membership.workspaceId,
          title: parsed.data.title.trim(),
          description: parsed.data.description ?? null,
          targetAmount: new Prisma.Decimal(parsed.data.targetAmount),
          savedAmount: new Prisma.Decimal(parsed.data.savedAmount ?? 0),
          dueDate: dateOnly(parsed.data.dueDate),
          icon: parsed.data.icon ?? null,
          color: parsed.data.color ?? null,
        },
        include: goalInclude,
      });
      // Fire-and-forget LLM strategy generation. The user gets an
      // immediate 201; the detail screen polls / refetches when shown
      // and picks up the strategy once Gemini returns.
      void generateAndStoreGoalStrategy(app.fina.env, created.id).catch(
        () => {
          // Swallowed inside the helper, but belt-and-suspenders here too.
        },
      );
      const saved = await computeGoalSavings(
        ctx.membership.workspaceId,
        created.id,
      );
      return reply.code(201).send({ goal: dto(created, saved) });
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
        const row = await prisma.goal.findFirst({
          where: { id: req.params.goalId, workspaceId: ctx.membership.workspaceId },
          select: { id: true },
        });
        if (!row) return reply.code(404).send({ error: "not_found" });
        const d = parsed.data;
        const data: Prisma.GoalUpdateInput = {};
        if (d.title !== undefined) data.title = d.title.trim();
        if (d.description !== undefined) data.description = d.description;
        if (d.targetAmount !== undefined)
          data.targetAmount = new Prisma.Decimal(d.targetAmount);
        if (d.savedAmount !== undefined)
          data.savedAmount = new Prisma.Decimal(d.savedAmount);
        if (d.dueDate !== undefined) data.dueDate = dateOnly(d.dueDate);
        if (d.icon !== undefined) data.icon = d.icon;
        if (d.color !== undefined) data.color = d.color;
        if (d.archived !== undefined) {
          data.archivedAt = d.archived ? new Date() : null;
        }
        const updated = await prisma.goal.update({
          where: { id: row.id },
          data,
          include: goalInclude,
        });
        const saved = await computeGoalSavings(
          ctx.membership.workspaceId,
          updated.id,
        );
        return reply.code(200).send({ goal: dto(updated, saved) });
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
        const row = await prisma.goal.findFirst({
          where: { id: req.params.goalId, workspaceId: ctx.membership.workspaceId },
          select: { id: true },
        });
        if (!row) return reply.code(404).send({ error: "not_found" });
        // Wait for generation to complete here (small + bounded) so the
        // caller can refresh once and see the new plan, rather than poll.
        await generateAndStoreGoalStrategy(app.fina.env, row.id);
        const updated = await prisma.goal.findUniqueOrThrow({
          where: { id: row.id },
          include: goalInclude,
        });
        const saved = await computeGoalSavings(
          ctx.membership.workspaceId,
          updated.id,
        );
        return reply.code(200).send({ goal: dto(updated, saved) });
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
