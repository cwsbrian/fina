import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";

const MAX_NAME_LEN = 40;
const MAX_ACTIVE_CATEGORIES = 30;

// Use .trim() BEFORE .min(1) so "   " (only spaces) is rejected as empty.
const CreateBody = z.object({ name: z.string().trim().min(1).max(MAX_NAME_LEN) });

const PatchBody = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN).optional(), // trim before min(1) to reject "   "
  icon: z.string().max(40).optional().nullable(),
  color: z.string().max(20).optional().nullable(),
  archived: z.boolean().optional(),
});

export async function categoriesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/categories", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const cats = await prisma.category.findMany({
        where: { workspaceId: ctx.membership.workspaceId, archivedAt: null },
        orderBy: { name: "asc" },
        select: { id: true, name: true, icon: true, color: true },
      });
      return { categories: cats };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post("/workspaces/:id/categories", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }

      const wsId = ctx.membership.workspaceId;
      const nameTrim = parsed.data.name.trim();

      // Count active categories
      const activeCount = await prisma.category.count({
        where: { workspaceId: wsId, archivedAt: null },
      });
      if (activeCount >= MAX_ACTIVE_CATEGORIES) {
        return reply.code(422).send({ error: "too_many_categories" });
      }

      // Case-insensitive active duplicate check
      const dup = await prisma.category.findFirst({
        where: {
          workspaceId: wsId,
          archivedAt: null,
          name: { equals: nameTrim, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (dup) return reply.code(422).send({ error: "duplicate_name" });

      const created = await prisma.category.create({
        data: { workspaceId: wsId, name: nameTrim },
        select: { id: true, name: true, icon: true, color: true },
      });
      return reply.code(201).send({ category: created });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.patch("/workspaces/:id/categories/:catId", async (req, reply) => {
    const params = req.params as { id: string; catId: string };
    const parsed = PatchBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }

      const wsId = ctx.membership.workspaceId;
      const existing = await prisma.category.findUnique({
        where: { id: params.catId },
        select: { id: true, workspaceId: true, name: true },
      });
      if (!existing || existing.workspaceId !== wsId) {
        return reply.code(404).send({ error: "not_found" });
      }

      // Build a properly-typed update object (Record<string,unknown> would
      // fail strict Prisma assignability checks).
      type CategoryPatch = {
        name?: string;
        icon?: string | null;
        color?: string | null;
        archivedAt?: Date | null;
      };
      const data: CategoryPatch = {};
      if (parsed.data.name !== undefined) {
        const nameTrim = parsed.data.name.trim();
        if (nameTrim.toLowerCase() !== existing.name.toLowerCase()) {
          const dup = await prisma.category.findFirst({
            where: {
              workspaceId: wsId,
              archivedAt: null,
              name: { equals: nameTrim, mode: "insensitive" },
              id: { not: params.catId },
            },
            select: { id: true },
          });
          if (dup) return reply.code(422).send({ error: "duplicate_name" });
        }
        data.name = nameTrim;
      }
      if (parsed.data.icon !== undefined) data.icon = parsed.data.icon;
      if (parsed.data.color !== undefined) data.color = parsed.data.color;
      if (parsed.data.archived !== undefined) {
        // Unarchiving: check both the 30-category cap AND duplicate names.
        // If "Groceries" is archived and an active "groceries" already exists,
        // restoring it would hit the CI partial unique index → P2002 → 500.
        if (!parsed.data.archived) {
          const activeCount = await prisma.category.count({
            where: { workspaceId: wsId, archivedAt: null },
          });
          if (activeCount >= MAX_ACTIVE_CATEGORIES) {
            return reply.code(422).send({ error: "too_many_categories" });
          }
          const dupActive = await prisma.category.findFirst({
            where: {
              workspaceId: wsId,
              archivedAt: null,
              name: { equals: existing.name, mode: "insensitive" },
              id: { not: params.catId },
            },
            select: { id: true },
          });
          if (dupActive) return reply.code(422).send({ error: "duplicate_name" });
        }
        data.archivedAt = parsed.data.archived ? new Date() : null;
      }

      const updated = await prisma.category.update({
        where: { id: params.catId },
        data,
        select: { id: true, name: true, icon: true, color: true, archivedAt: true },
      });
      return { category: updated };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
