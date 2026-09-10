import type { FastifyInstance } from "fastify";
import { HttpError, registerPersonalWorkspaceGate, requireWorkspaceContext } from "../auth/context.js";
import { getAnalysis, getLatestAnalysis } from "../analysis/service.js";

function parseYM(q: { year?: string; month?: string }): { year: number; month: number } | null {
  const now = new Date();
  const yearRaw = q.year ? Number(q.year) : now.getUTCFullYear();
  const monthRaw = q.month ? Number(q.month) : now.getUTCMonth() + 1;
  if (!Number.isFinite(yearRaw) || !Number.isFinite(monthRaw)) return null;
  if (yearRaw < 1970 || yearRaw > 2100) return null;
  if (monthRaw < 1 || monthRaw > 12) return null;
  return { year: yearRaw, month: monthRaw };
}

export async function analysisRoutes(app: FastifyInstance): Promise<void> {
  registerPersonalWorkspaceGate(app, { allowGet: false });
  app.get<{ Params: { id: string }; Querystring: { year?: string; month?: string } }>(
    "/workspaces/:id/analysis",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const ym = parseYM(req.query);
        if (!ym) return reply.code(400).send({ error: "invalid_year_month" });
        const hasExplicitPeriod =
          req.query.year !== undefined || req.query.month !== undefined;
        const result = hasExplicitPeriod
          ? await getAnalysis(ctx.membership.workspaceId, ym.year, ym.month)
          : await getLatestAnalysis(ctx.membership.workspaceId, ym.year, ym.month);
        return reply.send(result);
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        throw e;
      }
    },
  );
}
