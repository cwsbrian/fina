import type { FastifyInstance } from "fastify";
import {
  CreateWorkspaceBody,
  PatchMemberRoleBody,
  PatchWorkspaceCurrencyBody,
  type Role,
} from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession, requireWorkspaceContext } from "../auth/context.js";
import { DEFAULT_ACCOUNTS } from "../accounts/seed.js";
import {
  listMembers,
  updateMemberRole,
  removeMember,
  transferOwner,
  MembersServiceError,
} from "../workspaces/members.js";
import { createWorkspaceForUser } from "../workspaces/bootstrap.js";

const DEFAULT_ACCOUNT_NAMES = DEFAULT_ACCOUNTS.map((a) => a.name);

function mapMembersError(e: unknown): { statusCode: number; code: string } {
  if (e instanceof MembersServiceError) {
    switch (e.code) {
      case "not_found":
        return { statusCode: 404, code: "not_found" };
      case "last_owner":
      case "conflict":
        return { statusCode: 409, code: e.code };
      case "use_transfer":
      case "same_user":
        return { statusCode: 400, code: e.code };
      case "not_owner":
        return { statusCode: 403, code: "not_owner" };
      default: {
        // Compile-time exhaustiveness — adding a new MembersCode without
        // updating this switch is a TS error here, not a silent 500.
        const _exhaustive: never = e.code;
        void _exhaustive;
      }
    }
  }
  return { statusCode: 500, code: "internal" };
}

export async function workspacesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const memberships = await prisma.membership.findMany({
        where: { userId: session.userId },
        include: { workspace: true },
        orderBy: { workspace: { createdAt: "asc" } },
      });
      return {
        workspaces: memberships.map((m) => ({
          id: m.workspace.id,
          name: m.workspace.name,
          role: m.role as Role,
          currency: m.workspace.currency,
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post("/workspaces", async (req, reply) => {
    const parsed = CreateWorkspaceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const session = await requireSession(req, app);
      const result = await createWorkspaceForUser({
        userId: session.userId,
        name: parsed.data.name,
        ...(parsed.data.currency ? { currency: parsed.data.currency } : {}),
      });
      return reply.code(201).send(result);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/workspaces/:id/members", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      // Path id must match header to avoid confused-deputy; we trust the header context.
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const members = await listMembers({ workspaceId: ctx.membership.workspaceId });
      return { members };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.patch("/workspaces/:id/members/:userId", async (req, reply) => {
    const params = req.params as { id: string; userId: string };
    const parsed = PatchMemberRoleBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const newRole = parsed.data.role as Role;
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      if (newRole === "owner") {
        await transferOwner({
          workspaceId: ctx.membership.workspaceId,
          currentOwnerId: ctx.session.userId,
          newOwnerId: params.userId,
        });
      } else {
        await updateMemberRole({
          workspaceId: ctx.membership.workspaceId,
          targetUserId: params.userId,
          newRole,
        });
      }
      return reply.code(200).send({ ok: true });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapMembersError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.patch<{ Params: { id: string } }>(
    "/workspaces/:id/currency",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const parsed = PatchWorkspaceCurrencyBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "invalid_body" });
        }
        const wsId = ctx.membership.workspaceId;
        const updated = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wsId}))`;
          const [txCount, customAcctCount, recurringCount, budgetCount] = await Promise.all([
            tx.transaction.count({ where: { workspaceId: wsId } }),
            tx.bankAccount.count({
              where: {
                workspaceId: wsId,
                OR: [
                  { plaidItemId: { not: null } },
                  { name: { notIn: DEFAULT_ACCOUNT_NAMES } },
                ],
              },
            }),
            tx.recurringExpense.count({ where: { workspaceId: wsId } }),
            tx.budgetPlan.count({
              where: {
                workspaceId: wsId,
                OR: [
                  { totalAmount: { gt: 0 } },
                  { categoryAllocations: { not: [] } },
                ],
              },
            }),
          ]);
          if (txCount + customAcctCount + recurringCount + budgetCount > 0) {
            throw new HttpError(409, "workspace_has_data");
          }
          await tx.bankAccount.updateMany({
            where: { workspaceId: wsId, name: { in: DEFAULT_ACCOUNT_NAMES } },
            data: { currency: parsed.data.currency },
          });
          return await tx.workspace.update({
            where: { id: wsId },
            data: { currency: parsed.data.currency },
            select: { id: true, name: true, currency: true },
          });
        });
        return reply.send({ workspace: updated });
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        throw err;
      }
    },
  );

  app.delete("/workspaces/:id/members/:userId", async (req, reply) => {
    const params = req.params as { id: string; userId: string };
    try {
      const session = await requireSession(req, app);
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const isSelf = params.userId === session.userId;
      if (!isSelf && ctx.membership.role !== "owner") {
        return reply.code(403).send({ error: "insufficient_role" });
      }
      await removeMember({
        workspaceId: ctx.membership.workspaceId,
        targetUserId: params.userId,
      });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapMembersError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });
}
