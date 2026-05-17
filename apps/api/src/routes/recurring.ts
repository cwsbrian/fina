import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requireWorkspaceContext, HttpError } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import {
  addRecurringService,
  listRecurringService,
  removeRecurringByIdService,
} from "../recurring/service.js";

const CADENCE = z.enum(["monthly", "semimonthly", "biweekly", "weekly", "yearly"]);
const PostBody = z.object({
  name: z.string().trim().min(1).max(100),
  amount: z.number(),  // service validates positive/cap — 0/neg surfaces as invalid_amount
  cadence: CADENCE,
  nextOccurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  categoryId: z.string().min(1).optional(),
  merchant: z.string().min(1).max(200).optional(),
  currency: z.string().length(3).optional(),
});

export async function recurringRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/recurring", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = PostBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });

      // Build the service input WITHOUT the optional keys when their values
      // are undefined — tsconfig.base.json has `exactOptionalPropertyTypes: true`,
      // which rejects `{ categoryId: undefined }` against `categoryId?: string | null`.
      const serviceInput: Parameters<typeof addRecurringService>[1] = {
        name: parsed.data.name,
        amount: parsed.data.amount,
        cadence: parsed.data.cadence,
        nextOccurrenceDate: parsed.data.nextOccurrenceDate,
      };
      if (parsed.data.categoryId !== undefined) serviceInput.categoryId = parsed.data.categoryId;
      if (parsed.data.merchant !== undefined) serviceInput.merchant = parsed.data.merchant;
      if (parsed.data.currency !== undefined) serviceInput.currency = parsed.data.currency;
      const result = await addRecurringService(
        { workspaceId: ctx.membership.workspaceId },
        serviceInput,
      );
      return reply.code(201).send(result);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const msg = (e as Error).message;
      if (msg === "invalid_amount") return reply.code(400).send({ error: "invalid_amount" });
      if (msg === "invalid_next_date") return reply.code(400).send({ error: "invalid_next_date" });
      if (msg === "invalid_merchant") return reply.code(400).send({ error: "invalid_merchant" });
      if (msg === "invalid_body") return reply.code(400).send({ error: "invalid_body" });
      if (msg === "category_not_found") return reply.code(404).send({ error: "category_not_found" });
      throw e;
    }
  });

  app.get("/workspaces/:id/recurring", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      return await listRecurringService({ workspaceId: ctx.membership.workspaceId });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.delete("/workspaces/:id/recurring/:recurringId", async (req, reply) => {
    const params = req.params as { id: string; recurringId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (tier.tier !== "pro") return reply.code(402).send({ error: "upgrade_required" });
      const ok = await removeRecurringByIdService(
        { workspaceId: ctx.membership.workspaceId },
        { id: params.recurringId },
      );
      if (!ok) return reply.code(404).send({ error: "recurring_not_found" });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
