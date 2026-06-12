import type { FastifyInstance } from "fastify";
import type { $Enums, Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { computeEffectiveTier } from "../auth/tier.js";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  PatchMeBody,
  resolveNotificationPrefs,
  type MeDTO,
  type NotificationPrefs,
  type SubscriptionDTO,
} from "@fina/shared";
import {
  sendBriefPush,
  sendBankReconnectPush,
  sendWorkspaceInvitePush,
  sendTrialExpiringPush,
  sendGoalMilestonePush,
  sendLargeChargePush,
  sendTransactionAddedPush,
  sendProductUpdatePush,
} from "../push/send.js";
import { localMidnightToUtc } from "../chat/tools/periods.js";
import { pickPrimarySub, filterEnvironmentRows } from "../billing/precedence.js";
import { billingRecoveryForMe } from "../billing/recovery.js";
import { refreshDueIapSubscriptionsForUser } from "../iap/refresh.js";
import type { RefreshDueIapOptions } from "../iap/refresh.js";
import {
  iapIntegrityForMe,
  readNativeIapClient,
  touchNativeIapDevice,
  type NativeIapPlatform,
} from "../iap/integrity.js";

/** Convert "YYYY-MM-DD" + tz → UTC instant at NOON in that tz. Noon (not
 *  midnight) so the row's date-portion-in-tz unambiguously reads as the
 *  user's intended date regardless of any DST quirks at midnight. */
function tzNoonUtc(dateStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const midnightUtc = localMidnightToUtc(y!, m!, d!, tz);
  return new Date(midnightUtc.getTime() + 12 * 60 * 60 * 1000);
}

function toMeDTO(
  user: NonNullable<Awaited<ReturnType<typeof prisma.user.findUnique>>>,
  activeSubs: Array<{ tier: string; status: string; currentPeriodEnd: Date; cancelAtPeriodEnd: boolean; source: SubscriptionDTO["source"]; pendingTier: string | null; pendingTierAt: Date | null; environment: string; createdAt: Date; updatedAt: Date; sourceSubscriptionId: string }>,
  runtimeEnv: "sandbox" | "production",
  iapDevice: Awaited<ReturnType<typeof touchNativeIapDevice>>,
  iapPlatform: NativeIapPlatform | null,
): MeDTO {
  // Sandbox env filter MUST run before precedence — stale sandbox rows
  // should not influence the primary pick or the EffectiveTier.
  const filtered = filterEnvironmentRows(activeSubs, runtimeEnv);
  const t = computeEffectiveTier(user, filtered as unknown as Parameters<typeof computeEffectiveTier>[1]);
  // Deterministic primary-sub pick: Stripe wins unconditionally;
  // inside non-Stripe, max > pro; then source order; then createdAt ASC.
  // MeDTO.subscription is null when no active sub.
  const primary = pickPrimarySub(filtered);
  const subscription: SubscriptionDTO | null = primary
    ? {
        tier: primary.tier as "pro" | "max",
        status: primary.status as SubscriptionDTO["status"],
        currentPeriodEnd: primary.currentPeriodEnd.toISOString(),
        cancelAtPeriodEnd: primary.cancelAtPeriodEnd,
        source: primary.source as SubscriptionDTO["source"],
        pendingTier: primary.pendingTier as "pro" | "max" | null,
        pendingTierAt: primary.pendingTierAt?.toISOString() ?? null,
      }
    : null;
  // snoozeUntil → "YYYY-MM-DD" string (date portion in UTC; close enough for
  // settings UI display purposes; tz conversion in cron is what matters).
  const snoozeUntilStr = user.snoozeUntil
    ? user.snoozeUntil.toISOString().slice(0, 10)
    : null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      tz: user.tz,
      locale: user.locale,
      morningTime: user.morningTime,
      snoozeUntil: snoozeUntilStr,
      pauseEnabled: user.pauseEnabled,
      notificationPrefs: resolveNotificationPrefs(user.notificationPrefs),
      categorizationMode: user.categorizationMode,
    },
    tier: t.tier,
    trial: { active: t.trialActive, endsAt: t.trialEndsAt?.toISOString() ?? null },
    subscription,
    billingRecovery: billingRecoveryForMe(user, primary, iapDevice),
    iapIntegrity: iapIntegrityForMe(user, primary, iapPlatform, iapDevice),
  };
}

export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const nativeIapClient = readNativeIapClient(req);
      const injected = (app.fina.iap ?? {}) as {
        appleClient?: RefreshDueIapOptions["appleClient"];
        googleClient?: RefreshDueIapOptions["googleClient"];
      };
      const refreshOpts: RefreshDueIapOptions = {};
      if (injected.appleClient) refreshOpts.appleClient = injected.appleClient;
      if (injected.googleClient) refreshOpts.googleClient = injected.googleClient;
      try {
        await refreshDueIapSubscriptionsForUser(session.userId, refreshOpts);
      } catch (e) {
        app.log.warn({ err: e, userId: session.userId }, "iap_due_refresh_failed");
      }
      const [user, iapDevice] = await Promise.all([
        prisma.user.findUnique({ where: { id: session.userId } }),
        touchNativeIapDevice(session.userId, nativeIapClient),
      ]);
      if (!user) return reply.code(404).send({ error: "no_user" });
      const activeSubs = await prisma.subscription.findMany({
        where: { userId: user.id, status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] } },
        orderBy: { currentPeriodEnd: "desc" },
      });
      const runtimeEnv = app.fina.env.APPLE_ENV === "production" ? "production" : "sandbox";
      return toMeDTO(user, activeSubs, runtimeEnv, iapDevice, nativeIapClient?.platform ?? null);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  // Dev-only endpoint to fire a sample push of any channel to the
  // authenticated user. Goes through the real per-channel wrappers so
  // pref gating still applies — toggle the channel on in /notifications
  // before testing it.
  app.post("/me/test-push", async (req, reply) => {
    if (app.fina.env.NODE_ENV === "production") {
      return reply.code(404).send({ error: "not_found" });
    }
    try {
      const session = await requireSession(req, app);
      const body = (req.body ?? {}) as { channel?: string };
      const channel = body.channel as keyof NotificationPrefs;
      const env = app.fina.env;
      let result: { sent: number; failed: number };
      switch (channel) {
        case "morningBrief":
          result = await sendBriefPush(env, session.userId, "Test brief. Yesterday looked normal.");
          break;
        case "bankReconnect":
          result = await sendBankReconnectPush(env, session.userId, "Test Bank");
          break;
        case "workspaceInvites":
          result = await sendWorkspaceInvitePush(env, session.userId, "Test inviter", "Test workspace");
          break;
        case "trialExpiring":
          result = await sendTrialExpiringPush(env, session.userId, 3);
          break;
        case "goalMilestones":
          result = await sendGoalMilestonePush(env, session.userId, "Test goal", 50);
          break;
        case "largeCharges":
          result = await sendLargeChargePush(env, session.userId, "Test merchant", "199.99", "Dining");
          break;
        case "transactionAdded":
          result = await sendTransactionAddedPush(env, session.userId, "Test Merchant", "12.34", "Dining");
          break;
        case "productUpdates":
          result = await sendProductUpdatePush(env, session.userId, "What's new in Fina", "Test product update.");
          break;
        default:
          return reply.code(400).send({ error: "invalid_channel" });
      }
      // Also surface device count so the caller can disambiguate
      // "channel disabled" vs "no device registered".
      const deviceCount = await prisma.userDevice.count({
        where: { userId: session.userId },
      });
      const channelEnabled = resolveNotificationPrefs(
        (await prisma.user.findUnique({
          where: { id: session.userId },
          select: { notificationPrefs: true },
        }))?.notificationPrefs,
      )[channel];
      return {
        sent: result.sent,
        failed: result.failed,
        deviceCount,
        channelEnabled,
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.patch("/me", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = PatchMeBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const body = parsed.data;

      // Build a Prisma update payload — only fields explicitly present in
      // the body. snoozeUntil has tri-state (undefined no-op, null clear,
      // string set).
      const data: Prisma.UserUpdateInput = {};
      if (body.name !== undefined) data.name = body.name;
      if (body.morningTime !== undefined) data.morningTime = body.morningTime;
      if (body.pauseEnabled !== undefined) data.pauseEnabled = body.pauseEnabled;
      if (body.tz !== undefined) data.tz = body.tz;
      if (body.notificationPrefs !== undefined) {
        // Partial patch: merge incoming keys on top of whatever's stored
        // (or defaults if nothing stored yet).
        const existing = await prisma.user.findUniqueOrThrow({
          where: { id: session.userId },
          select: { notificationPrefs: true },
        });
        const current = resolveNotificationPrefs(existing.notificationPrefs);
        data.notificationPrefs = {
          ...current,
          ...body.notificationPrefs,
        } as unknown as Prisma.InputJsonValue;
      }
      if (body.categorizationMode !== undefined) {
        data.categorizationMode = body.categorizationMode;
      }
      if (body.snoozeUntil !== undefined) {
        // null clears; "YYYY-MM-DD" sets to UTC noon in user's tz.
        if (body.snoozeUntil === null) {
          data.snoozeUntil = null;
        } else {
          // Need the user's tz BEFORE the update applies — if the PATCH
          // body includes a new tz, that's the tz to interpret snoozeUntil
          // against. Else use existing User.tz.
          const tzForSnooze = body.tz ?? (await prisma.user.findUniqueOrThrow({
            where: { id: session.userId },
            select: { tz: true },
          })).tz;
          data.snoozeUntil = tzNoonUtc(body.snoozeUntil, tzForSnooze);
        }
      }

      const updated = await prisma.user.update({
        where: { id: session.userId },
        data,
      });
      const nativeIapClient = readNativeIapClient(req);
      const iapDevice = await touchNativeIapDevice(session.userId, nativeIapClient);
      const activeSubs = await prisma.subscription.findMany({
        where: { userId: updated.id, status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] } },
        orderBy: { currentPeriodEnd: "desc" },
      });
      const runtimeEnv = app.fina.env.APPLE_ENV === "production" ? "production" : "sandbox";
      return toMeDTO(updated, activeSubs, runtimeEnv, iapDevice, nativeIapClient?.platform ?? null);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
