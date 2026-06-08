import type { FastifyInstance } from "fastify";
import { isPaidFeatureTier } from "@fina/shared";
import { requireWorkspaceContext, HttpError } from "../auth/context.js";
import { effectiveTier } from "../auth/tier.js";
import { consumeIntentService } from "../intents/service.js";

export async function intentsRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/intents/:intentId/consume", async (req, reply) => {
    const params = req.params as { id: string; intentId: string };
    // Form blocks send their edited values in the body. Untyped record
    // — the consume service re-validates against the target tool's
    // zod schema, so a bad/extra field fails with invalid_payload_args
    // the same way a malformed LLM call would.
    const body = (req.body ?? {}) as {
      overrides?: Record<string, unknown>;
      threadId?: string;
    };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const tier = await effectiveTier(ctx.session.userId);
      if (!isPaidFeatureTier(tier.tier)) return reply.code(402).send({ error: "upgrade_required" });

      const result = await consumeIntentService(
        {
          workspaceId: ctx.membership.workspaceId,
          userId: ctx.session.userId,
          role: ctx.membership.role,
          env: app.fina.env,
        },
        params.intentId,
        body.overrides,
        body.threadId,
      );
      return reply.code(200).send(result);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const msg = (e as Error).message;
      if (msg === "intent_not_found") return reply.code(404).send({ error: "intent_not_found" });
      if (msg === "intent_owner_mismatch")
        return reply.code(403).send({ error: "intent_owner_mismatch" });
      if (msg === "intent_gone") return reply.code(410).send({ error: "intent_gone" });
      if (msg === "insufficient_role")
        return reply.code(403).send({ error: "insufficient_role" });
      throw e;
    }
  });
}
