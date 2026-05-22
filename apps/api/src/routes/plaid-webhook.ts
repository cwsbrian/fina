import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { verifyPlaidWebhook, PlaidWebhookVerifyError } from "../plaid/webhook-jwks.js";
import { dispatchWebhookSync } from "../plaid/webhook-dispatch.js";
import { dispatchItemEvent } from "../plaid/webhook-item.js";
import { logError, logInfo } from "../logger.js";

const WebhookBodySchema = z.object({
  webhook_type: z.string(),
  webhook_code: z.string(),
  item_id: z.string(),
}).passthrough();

export async function plaidWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Override the JSON parser to give us the raw buffer (we need the bytes
  // for SHA-256 hashing, which Fastify's default parser destroys by re-stringifying).
  // Scoped to this plugin's encapsulation context — does NOT affect other routes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/plaid/webhook", async (req, reply) => {
    const rawBody = req.body as Buffer;
    const jwt = req.headers["plaid-verification"];
    const jwtStr = Array.isArray(jwt) ? jwt[0] : jwt;

    try {
      await verifyPlaidWebhook(app.fina.env, rawBody, jwtStr);
    } catch (e) {
      if (e instanceof PlaidWebhookVerifyError) {
        return reply.code(401).send({ error: e.code });
      }
      throw e;
    }

    let parsed: z.infer<typeof WebhookBodySchema>;
    try {
      parsed = WebhookBodySchema.parse(JSON.parse(rawBody.toString("utf8")));
    } catch {
      return reply.code(400).send({ error: "invalid_body" });
    }

    const item = await prisma.plaidItem.findUnique({
      where: { itemId: parsed.item_id },
      select: { id: true, workspaceId: true, status: true },
    });

    const event = await prisma.plaidWebhookEvent.create({
      data: {
        plaidItemId: item?.id ?? null,
        webhookType: parsed.webhook_type,
        webhookCode: parsed.webhook_code,
        body: parsed as object,
      },
      select: { id: true },
    });

    const isSyncRelevant =
      parsed.webhook_type === "TRANSACTIONS" &&
      parsed.webhook_code === "SYNC_UPDATES_AVAILABLE" &&
      item !== null;
    const isItemRelevant = parsed.webhook_type === "ITEM" && item !== null;

    if (isSyncRelevant) {
      void dispatchWebhookSync(app.fina.env, item.workspaceId, item.id, event.id).catch((err) => {
        logError(
          { plaidEvent: parsed.webhook_code, plaidItemId: item.id, err },
          "plaid webhook dispatch failed",
        );
      });
    } else if (isItemRelevant) {
      void dispatchItemEvent(
        item,
        parsed as { webhook_code: string; error?: { error_code?: string | null } | null },
      ).catch((e) => {
        logError({ err: e, plaidItemId: item.id }, "ITEM webhook dispatch failed");
      });
    } else {
      logInfo(
        { plaidEvent: `${parsed.webhook_type}/${parsed.webhook_code}`, plaidItemId: item?.id },
        "webhook received but not dispatched",
      );
    }

    return reply.code(200).send({});
  });
}
