import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";

const AccountsQuerySchema = z.object({
  // Archived accounts (archivedAt IS NOT NULL) are excluded by default — they
  // belong to disconnected Plaid items and the UI hides them per spec. Pass
  // `?includeArchived=true` to include them (e.g. transaction-history views).
  includeArchived: z.enum(["true", "false"]).transform((v) => v === "true").optional().default("false"),
});

export async function accountsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/accounts", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = AccountsQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const { includeArchived } = parsed.data;
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const rows = await prisma.bankAccount.findMany({
        where: {
          workspaceId: ctx.membership.workspaceId,
          ...(includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: { createdAt: "desc" },
      });
      return {
        accounts: rows.map((a) => ({
          id: a.id,
          plaidItemId: a.plaidItemId,
          plaidAccountId: a.plaidAccountId,
          name: a.name,
          officialName: a.officialName,
          mask: a.mask,
          type: a.type,
          subtype: a.subtype,
          currency: a.currency,
          status: a.status,
          balanceCurrent: a.balanceCurrent?.toString() ?? null,
          balanceAvailable: a.balanceAvailable?.toString() ?? null,
          balanceLimit: a.balanceLimit?.toString() ?? null,
          archivedAt: a.archivedAt?.toISOString() ?? null,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
