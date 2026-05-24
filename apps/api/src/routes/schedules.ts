import type { FastifyInstance } from "fastify";
import { PostScheduledSpendBody, ListScheduledSpendsQuery } from "@fina/shared";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import {
  addScheduledSpendService,
  listScheduledSpendsService,
  dismissScheduledSpendService,
  removeScheduledSpendService,
  updateScheduledSpendService,
  ScheduledSpendError,
  type AddScheduledSpendInput,
  type ScheduledSpendStatus,
  type UpdateScheduledSpendInput,
} from "../schedules/service.js";

function statusFromCode(code: ScheduledSpendError["code"]): number {
  if (code === "not_found" || code === "category_not_found") return 404;
  return 400;  // invalid_*, already_matched
}

export async function schedulesRoutes(app: FastifyInstance): Promise<void> {
  // POST /workspaces/:id/schedules
  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/schedules",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const parsed = PostScheduledSpendBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

        const input: AddScheduledSpendInput = {
          workspaceId: ctx.membership.workspaceId,
          categoryId: parsed.data.categoryId,
          amount: parsed.data.amount,
          scheduledDate: parsed.data.scheduledDate,
        };
        if (parsed.data.note !== undefined) input.note = parsed.data.note;

        const result = await addScheduledSpendService(input);
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        if (err instanceof ScheduledSpendError) return reply.code(statusFromCode(err.code)).send({ error: err.code });
        throw err;
      }
    },
  );

  // GET /workspaces/:id/schedules
  app.get<{ Params: { id: string } }>(
    "/workspaces/:id/schedules",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const q = ListScheduledSpendsQuery.safeParse(req.query);
        if (!q.success) return reply.code(400).send({ error: "invalid_query" });

        const filter: Parameters<typeof listScheduledSpendsService>[1] = {};
        if (q.data.from) filter.from = new Date(q.data.from);
        if (q.data.to) filter.to = new Date(q.data.to);
        if (q.data.status) filter.status = q.data.status as ScheduledSpendStatus | "all";

        const result = await listScheduledSpendsService(
          { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
          filter,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        throw err;
      }
    },
  );

  // PATCH /workspaces/:id/schedules/:scheduleId — full-replace edit
  app.patch<{ Params: { id: string; scheduleId: string } }>(
    "/workspaces/:id/schedules/:scheduleId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const parsed = PostScheduledSpendBody.safeParse(req.body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

        const input: UpdateScheduledSpendInput = {
          workspaceId: ctx.membership.workspaceId,
          id: req.params.scheduleId,
          categoryId: parsed.data.categoryId,
          amount: parsed.data.amount,
          scheduledDate: parsed.data.scheduledDate,
        };
        if (parsed.data.note !== undefined) input.note = parsed.data.note;

        const result = await updateScheduledSpendService(input);
        return reply.send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        if (err instanceof ScheduledSpendError) return reply.code(statusFromCode(err.code)).send({ error: err.code });
        throw err;
      }
    },
  );

  // POST /workspaces/:id/schedules/:scheduleId/dismiss
  app.post<{ Params: { id: string; scheduleId: string } }>(
    "/workspaces/:id/schedules/:scheduleId/dismiss",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const result = await dismissScheduledSpendService(
          { workspaceId: ctx.membership.workspaceId },
          req.params.scheduleId,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        if (err instanceof ScheduledSpendError) return reply.code(statusFromCode(err.code)).send({ error: err.code });
        throw err;
      }
    },
  );

  // DELETE /workspaces/:id/schedules/:scheduleId
  app.delete<{ Params: { id: string; scheduleId: string } }>(
    "/workspaces/:id/schedules/:scheduleId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const result = await removeScheduledSpendService(
          { workspaceId: ctx.membership.workspaceId },
          req.params.scheduleId,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        throw err;
      }
    },
  );
}
