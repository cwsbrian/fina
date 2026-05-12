import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { requireProTier } from "../auth/tier.js";
import { syncTransactions } from "../plaid/sync.js";
import { removeItemStrict } from "../plaid/items.js";
import { categorizeNewTransactions } from "../categorize/service.js";
import { mapPlaidError } from "../plaid/client.js";

export async function plaidItemsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/plaid-items", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const items = await prisma.plaidItem.findMany({
        where: { workspaceId: ctx.membership.workspaceId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          institutionName: true,
          status: true,
          errorCode: true,
          lastSyncAt: true,
          _count: { select: { bankAccounts: true } },
        },
      });
      return {
        plaidItems: items.map((i) => ({
          id: i.id,
          institutionName: i.institutionName,
          status: i.status,
          errorCode: i.errorCode,
          lastSyncAt: i.lastSyncAt?.toISOString() ?? null,
          accountCount: i._count.bankAccounts,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post("/workspaces/:id/plaid-items/:itemId/sync", async (req, reply) => {
    const params = req.params as { id: string; itemId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      await requireProTier(ctx.session.userId);
      const r = await syncTransactions(app.fina.env, ctx.membership.workspaceId, params.itemId);
      // Await categorize so the response reflects the final categorized state.
      if ("newTxIds" in r && r.newTxIds.length > 0) {
        await categorizeNewTransactions(app.fina.env, ctx.membership.workspaceId, r.newTxIds);
      }
      // Surface partial-commit counters even on `skipped` so the UI can show
      // "Another refresh is running — got N transactions before yielding."
      return r;
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapPlaidError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.delete("/workspaces/:id/plaid-items/:itemId", async (req, reply) => {
    const params = req.params as { id: string; itemId: string };
    try {
      // INTENTIONAL EXCEPTION to "all Plaid-mutating routes are Pro-gated":
      // disconnect must NOT require Pro tier. If a user's trial expires
      // before they cancel/upgrade, they still need to be able to revoke
      // Plaid's access to their bank — gating that behind the paywall would
      // be a data trap. Owner-only is enforced; tier is not. The README and
      // master spec both note this exception in the same wording.
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      await removeItemStrict(app.fina.env, ctx.membership.workspaceId, params.itemId);
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapPlaidError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });
}
