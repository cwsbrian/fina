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

const CreateAccountBody = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.string().max(40).optional(),
});

const PatchAccountBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

function dto(a: {
  id: string;
  plaidItemId: string | null;
  plaidAccountId: string | null;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  currency: string;
  status: string;
  balanceCurrent: { toString: () => string } | null;
  balanceAvailable: { toString: () => string } | null;
  balanceLimit: { toString: () => string } | null;
  archivedAt: Date | null;
}): unknown {
  return {
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
  };
}

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
      return { accounts: rows.map(dto) };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.patch<{ Params: { id: string; accountId: string } }>(
    "/workspaces/:id/accounts/:accountId",
    async (req, reply) => {
      const body = (req.body as Record<string, unknown>) ?? {};
      const parsed = PatchAccountBody.safeParse(body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const row = await prisma.bankAccount.findFirst({
          where: { id: req.params.accountId, workspaceId: ctx.membership.workspaceId },
          select: { id: true, plaidAccountId: true },
        });
        if (!row) return reply.code(404).send({ error: "not_found" });
        // Plaid-linked rows are managed by sync — block name/archive edits.
        if (row.plaidAccountId !== null) {
          return reply.code(400).send({ error: "not_editable" });
        }
        const data: { name?: string; archivedAt?: Date | null } = {};
        if (parsed.data.name !== undefined) data.name = parsed.data.name.trim();
        if (parsed.data.archived !== undefined) {
          data.archivedAt = parsed.data.archived ? new Date() : null;
        }
        const updated = await prisma.bankAccount.update({
          where: { id: row.id },
          data,
        });
        return reply.code(200).send({ account: dto(updated) });
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        throw e;
      }
    },
  );

  app.post("/workspaces/:id/accounts", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = CreateAccountBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const workspace = await prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.membership.workspaceId },
        select: { currency: true },
      });
      const created = await prisma.bankAccount.create({
        data: {
          workspaceId: ctx.membership.workspaceId,
          name: parsed.data.name.trim(),
          type: parsed.data.type ?? "depository",
          currency: workspace.currency,
          status: "active",
        },
      });
      return reply.code(201).send({ account: dto(created) });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
