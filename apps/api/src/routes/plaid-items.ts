import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
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
      const [items, reconnectAccountCount, tier] = await Promise.all([
        prisma.plaidItem.findMany({
          where: { workspaceId: ctx.membership.workspaceId },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            institutionName: true,
            status: true,
            errorCode: true,
            lastSyncAt: true,
            billingGraceEndsAt: true,
            user: { select: { id: true, name: true, email: true } },
            _count: { select: { bankAccounts: true } },
          },
        }),
        prisma.bankAccount.count({
          where: {
            workspaceId: ctx.membership.workspaceId,
            archivedAt: { not: null },
            plaidReconnectRequired: true,
          },
        }),
        effectiveTier(ctx.session.userId),
      ]);
      return {
        plaidItems: items.map((i) => ({
          id: i.id,
          institutionName: i.institutionName,
          status: i.status,
          errorCode: i.errorCode,
          lastSyncAt: i.lastSyncAt?.toISOString() ?? null,
          billingGraceEndsAt: i.billingGraceEndsAt?.toISOString() ?? null,
          accountCount: i._count.bankAccounts,
          connectedByUserId: i.user?.id ?? null,
          connectedByName: i.user?.name ?? i.user?.email ?? null,
        })),
        reconnectRequired: reconnectAccountCount > 0,
        reconnectAccountCount,
        canConnectBank: tier.plaidItemLimit > 0,
        billingGraceActive: items.some(
          (item) => item.billingGraceEndsAt !== null && item.billingGraceEndsAt > new Date(),
        ),
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
      const item = await prisma.plaidItem.findFirst({
        where: {
          id: params.itemId,
          workspaceId: ctx.membership.workspaceId,
          connectedBy: ctx.session.userId,
          status: { not: "disconnected" },
        },
        select: { id: true },
      });
      if (!item) return reply.code(404).send({ error: "not_found" });

      const tier = await effectiveTier(ctx.session.userId);
      if (tier.plaidItemLimit <= 0) {
        return reply.code(402).send({ error: "upgrade_required" });
      }

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
    const query = req.query as { deleteTransactions?: string };
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
      await removeItemStrict(app.fina.env, ctx.membership.workspaceId, params.itemId, {
        deleteTransactions: query.deleteTransactions === "true",
      });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapPlaidError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });
}
