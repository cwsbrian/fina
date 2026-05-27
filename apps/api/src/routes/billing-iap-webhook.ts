import type { FastifyInstance } from "fastify";
import { OAuth2Client } from "google-auth-library";
import { prisma } from "../db.js";
import { HttpError } from "../auth/context.js";
import { requireIapEnv } from "../iap/env-guard.js";
import { verifyApplePayload, verifyGoogleEnvelope } from "../iap/webhook-verify.js";
import { syncSubscriptionFromIAP } from "../iap/sync-sub.js";
import { hashBindingToken } from "../iap/binding.js";
import { AppleClient } from "../iap/apple-client.js";
import { GoogleClient } from "../iap/google-client.js";

const MAX_UNKNOWN_RETRIES = 5;

export async function billingIapWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Override the JSON parser to give us the raw buffer, then parse manually.
  // Scoped to this plugin's encapsulation context — does NOT affect other routes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")));
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  let cached: {
    cfg: ReturnType<typeof requireIapEnv>;
    appleClient: AppleClient;
    googleClient: GoogleClient;
    oidcClient: OAuth2Client;
  } | null = null;

  const resolveCtx = () => {
    const injected = (app as any).fina?.iap as
      | { appleClient: AppleClient; googleClient: GoogleClient; oidcClient: OAuth2Client }
      | undefined;
    if (injected) {
      return { cfg: requireIapEnv(process.env), ...injected };
    }
    if (!cached) {
      const cfg = requireIapEnv(process.env);
      cached = {
        cfg,
        appleClient: new AppleClient(cfg.apple),
        googleClient: new GoogleClient(cfg.google),
        oidcClient: new OAuth2Client(),
      };
    }
    return cached;
  };

  app.post("/webhooks/iap/apple", async (req, reply) => {
    try {
      const { cfg, appleClient } = resolveCtx();
      const body = req.body as { signedPayload?: string };
      if (!body?.signedPayload) return reply.code(400).send({ error: "invalid_body" });

      const notification = await verifyApplePayload(body.signedPayload, cfg.apple, { appleClient });

      const eventId = `apple:${notification.notificationUUID}`;
      const existing = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
      if (existing) return { ok: true };

      // Family Sharing revocation — flip Subscription.status to canceled
      if (
        notification.notificationType === "DID_CHANGE_RENEWAL_STATUS" &&
        notification.subtype === "PRODUCT_NOT_FOR_SALE"
      ) {
        const verifiedTx = await appleClient.verifyAndDecodeTransaction(notification.signedTransactionJws, { context: "assn" });
        await prisma.subscription.updateMany({
          where: { source: "iap_apple", sourceSubscriptionId: verifiedTx.originalTransactionId },
          data: { status: "canceled" },
        });
        await prisma.webhookEvent.create({ data: { id: eventId, source: "iap_apple", type: "family_sharing_revoked" } });
        return { ok: true };
      }

      const verifiedTx = await appleClient.verifyAndDecodeTransaction(notification.signedTransactionJws, { context: "assn" });
      const bindingHash = hashBindingToken(verifiedTx.appAccountToken);

      // 4-step userId resolution
      // Step 1: existing Subscription row
      let userId: string | null = null;
      const sub = await prisma.subscription.findFirst({
        where: { source: "iap_apple", sourceSubscriptionId: verifiedTx.originalTransactionId },
        select: { userId: true },
      });
      if (sub) userId = sub.userId;

      // Step 2: user binding via iapAppleAccountToken
      if (!userId) {
        const user = await prisma.user.findUnique({ where: { iapAppleAccountToken: verifiedTx.appAccountToken } });
        if (user) userId = user.id;
      }

      // Step 3: IapDeletedBinding tombstone — user was deleted, stop retrying
      if (!userId) {
        const tombstone = await prisma.iapDeletedBinding.findUnique({
          where: { source_tokenHash: { source: "iap_apple", tokenHash: bindingHash } },
        });
        if (tombstone) {
          await prisma.webhookEvent.create({
            data: { id: eventId, source: "iap_apple", type: "unattributable_after_delete", body: { tokenHash: bindingHash } as any },
          });
          return reply.code(200).send({ ok: true });
        }
      }

      // Step 4: still unknown — increment retry counter; give up after cap
      if (!userId) {
        const counter = await prisma.iapRetryCounter.upsert({
          where: { source_tokenHash: { source: "iap_apple", tokenHash: bindingHash } },
          create: { source: "iap_apple", tokenHash: bindingHash, attempts: 1 },
          update: { attempts: { increment: 1 }, lastAt: new Date() },
        });
        if (counter.attempts > MAX_UNKNOWN_RETRIES) {
          await prisma.webhookEvent.create({
            data: { id: eventId, source: "iap_apple", type: "unattributable_giveup", body: { tokenHash: bindingHash, attempts: counter.attempts } as any },
          });
          return reply.code(200).send({ ok: true });
        }
        return reply.code(500).send({ error: "user_unknown" });
      }

      const ctx = resolveCtx();
      await syncSubscriptionFromIAP(cfg, {
        platform: "ios",
        receipt: notification.signedTransactionJws,
        userId,
        context: "assn",
      }, { appleClient: ctx.appleClient, googleClient: ctx.googleClient });

      await prisma.webhookEvent.create({ data: { id: eventId, source: "iap_apple", type: notification.notificationType } });
      return reply.code(200).send({ ok: true });
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 400) {
        return reply.code(400).send({ error: (e as HttpError).code });
      }
      app.log.error({ err: e }, "webhook_iap_apple_failed");
      return reply.code(500).send({ error: "webhook_handler_failed" });
    }
  });

  app.post("/webhooks/iap/google", async (req, reply) => {
    try {
      const { cfg, googleClient, oidcClient } = resolveCtx();
      const note = await verifyGoogleEnvelope(
        req.headers.authorization,
        req.body as any,
        cfg.google,
        { oidcClient },
      );

      const eventId = `google:${note.messageId}`;
      const existing = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
      if (existing) return { ok: true };

      if (note.kind === "ignore") {
        await prisma.webhookEvent.create({ data: { id: eventId, source: "iap_google", type: `ignored_${note.reason}` } });
        return { ok: true };
      }

      // 4-step userId resolution
      // Step 1: existing Subscription row
      let userId: string | null = null;
      const sub = await prisma.subscription.findFirst({
        where: { source: "iap_google", sourceSubscriptionId: note.payload.purchaseToken },
        select: { userId: true },
      });
      if (sub) userId = sub.userId;

      // Fetch purchase details regardless (needed for binding lookup)
      const v2 = await googleClient.fetchAndNormalize(note.payload.purchaseToken);
      const bindingHash = hashBindingToken(v2.obfuscatedExternalAccountId);

      // Step 2: user binding via iapGoogleObfuscatedId
      if (!userId) {
        const user = await prisma.user.findUnique({ where: { iapGoogleObfuscatedId: v2.obfuscatedExternalAccountId } });
        if (user) userId = user.id;
      }

      // Step 3: IapDeletedBinding tombstone
      if (!userId) {
        const tombstone = await prisma.iapDeletedBinding.findUnique({
          where: { source_tokenHash: { source: "iap_google", tokenHash: bindingHash } },
        });
        if (tombstone) {
          await prisma.webhookEvent.create({
            data: { id: eventId, source: "iap_google", type: "unattributable_after_delete", body: { tokenHash: bindingHash } as any },
          });
          return reply.code(200).send({ ok: true });
        }
      }

      // Step 4: still unknown — increment retry counter; give up after cap
      if (!userId) {
        const counter = await prisma.iapRetryCounter.upsert({
          where: { source_tokenHash: { source: "iap_google", tokenHash: bindingHash } },
          create: { source: "iap_google", tokenHash: bindingHash, attempts: 1 },
          update: { attempts: { increment: 1 }, lastAt: new Date() },
        });
        if (counter.attempts > MAX_UNKNOWN_RETRIES) {
          await prisma.webhookEvent.create({
            data: { id: eventId, source: "iap_google", type: "unattributable_giveup", body: { tokenHash: bindingHash, attempts: counter.attempts } as any },
          });
          return reply.code(200).send({ ok: true });
        }
        return reply.code(500).send({ error: "user_unknown" });
      }

      const ctx = resolveCtx();
      await syncSubscriptionFromIAP(cfg, {
        platform: "android",
        receipt: note.payload.purchaseToken,
        userId,
        context: "rtdn",
      }, { appleClient: ctx.appleClient, googleClient: ctx.googleClient });

      await prisma.webhookEvent.create({ data: { id: eventId, source: "iap_google", type: `notif_${note.payload.notificationType}` } });
      return reply.code(200).send({ ok: true });
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 400) {
        return reply.code(400).send({ error: (e as HttpError).code });
      }
      app.log.error({ err: e }, "webhook_iap_google_failed");
      return reply.code(500).send({ error: "webhook_handler_failed" });
    }
  });
}
