import type { FastifyInstance } from "fastify";
import { SetBudgetBody } from "@fina/shared";
import { requireWorkspaceContext, HttpError } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import {
  setBudgetService,
  getBudgetService,
  deleteBudgetService,
} from "../budgets/service.js";

// Note: amount is NOT constrained to positive() in SetBudgetBody so the
// service-level validation (`invalid_amount`) is what surfaces for
// 0/negative/over-cap values. Otherwise Zod would short-circuit with
// `invalid_body` and our tested error contract would break.

function isFirstOfMonth(s: string): boolean {
  // Shape: YYYY-MM-01, day component must literally be "01".
  if (!/^\d{4}-\d{2}-01$/.test(s)) return false;
  // Parse and round-trip to catch bogus months like "2026-13-01" or "2026-00-01".
  const [yStr, mStr] = s.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return false;
  if (m < 1 || m > 12) return false;
  const d = new Date(Date.UTC(y, m - 1, 1));
  if (Number.isNaN(d.getTime())) return false;
  const back = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  return back === s;
}

export async function budgetsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/budgets", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = SetBudgetBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });
      const result = await setBudgetService(
        { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
        parsed.data,
      );
      return reply.code(201).send(result);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const msg = (e as Error).message;
      if (msg === "invalid_amount") return reply.code(400).send({ error: "invalid_amount" });
      if (msg === "category_not_found") return reply.code(404).send({ error: "category_not_found" });
      throw e;
    }
  });

  app.get("/workspaces/:id/budgets", async (req, reply) => {
    const params = req.params as { id: string };
    const q = req.query as { period_start?: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      let result;
      if (q.period_start) {
        if (!isFirstOfMonth(q.period_start)) {
          return reply.code(400).send({ error: "invalid_period_start" });
        }
        result = await getBudgetService(
          { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
          { periodStart: new Date(`${q.period_start}T12:00:00.000Z`) },
        );
      } else {
        result = await getBudgetService(
          { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
          { period: "this_month" },
        );
      }
      return result;
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.delete("/workspaces/:id/budgets/:budgetId", async (req, reply) => {
    const params = req.params as { id: string; budgetId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });
      const ok = await deleteBudgetService(
        { workspaceId: ctx.membership.workspaceId },
        { budgetId: params.budgetId },
      );
      if (!ok) return reply.code(404).send({ error: "budget_not_found" });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
