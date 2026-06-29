import type { FastifyInstance } from "fastify";
import { Prisma, type $Enums } from "@prisma/client";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  type AdminUserDetailDTO,
  type AdminUserDTO,
  type AdminUsersResponse,
  type SubscriptionDTO,
} from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireAdminSession } from "../auth/context.js";
import { computeEffectiveTier } from "../auth/tier.js";
import { filterEnvironmentRows, pickPrimarySub } from "../billing/precedence.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type Cursor = {
  createdAt: string;
  id: string;
};

function parseLimit(value: unknown): number {
  if (typeof value !== "string") return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: unknown): Cursor | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "invalid_query");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      throw new HttpError(400, "invalid_query");
    }
    if (Number.isNaN(new Date(parsed.createdAt).getTime())) {
      throw new HttpError(400, "invalid_query");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new HttpError(400, "invalid_query");
  }
}

function toSubscriptionDTO(
  primary: {
    tier: string;
    status: string;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    source: string;
    pendingTier: string | null;
    pendingTierAt: Date | null;
    environment: string;
  } | null,
): AdminUserDTO["subscription"] {
  if (!primary) return null;
  return {
    tier: primary.tier as "pro" | "max",
    status: primary.status as SubscriptionDTO["status"],
    currentPeriodEnd: primary.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: primary.cancelAtPeriodEnd,
    source: primary.source as SubscriptionDTO["source"],
    pendingTier: primary.pendingTier as "pro" | "max" | null,
    pendingTierAt: primary.pendingTierAt?.toISOString() ?? null,
    environment: primary.environment,
  };
}

function inferPlatform(userAgent: string | null): string {
  const ua = userAgent?.toLowerCase() ?? "";
  if (ua.includes("android")) return "android";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) return "ios";
  return "web";
}

function maxIso(values: Array<Date | null | undefined>): string | null {
  const times = values
    .filter((v): v is Date => v instanceof Date)
    .map((v) => v.getTime());
  if (times.length === 0) return null;
  return new Date(Math.max(...times)).toISOString();
}

function deviceSummary(
  rows: Array<{ platform: string; lastSeenAt: Date | null }>,
): AdminUserDTO["deviceSummary"] {
  const byPlatform = new Map<string, Date | null>();
  for (const row of rows) {
    const current = byPlatform.get(row.platform);
    if (!current || (row.lastSeenAt && row.lastSeenAt > current)) {
      byPlatform.set(row.platform, row.lastSeenAt);
    }
  }
  return [...byPlatform.entries()]
    .sort((a, b) => (b[1]?.getTime() ?? 0) - (a[1]?.getTime() ?? 0))
    .map(([platform, lastSeenAt]) => ({
      platform,
      lastSeenAt: lastSeenAt?.toISOString() ?? null,
    }));
}

function adminUserDTO(
  user: {
    id: string;
    email: string;
    name: string | null;
    createdAt: Date;
    role: $Enums.UserRole;
    trialEndsAt: Date | null;
    trialConsumed: boolean;
    isPlanMismatch: boolean;
  },
  subs: Array<{
    tier: string;
    status: $Enums.SubscriptionStatus;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    source: $Enums.SubscriptionSource;
    pendingTier: string | null;
    pendingTierAt: Date | null;
    environment: string;
    createdAt: Date;
  }>,
  runtimeEnv: "production" | "sandbox",
  devices: AdminUserDTO["deviceSummary"] = [],
): AdminUserDTO {
  const filtered = filterEnvironmentRows(subs, runtimeEnv);
  const tier = computeEffectiveTier(user, filtered);
  const primary = pickPrimarySub(filtered);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    role: user.role,
    tier: tier.tier,
    trial: {
      active: tier.trialActive,
      endsAt: tier.trialEndsAt?.toISOString() ?? null,
    },
    subscription: toSubscriptionDTO(primary),
    deviceSummary: devices,
    activeSubscriptionCount: filtered.length,
    isPlanMismatch: user.isPlanMismatch,
  };
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/users", async (req, reply) => {
    try {
      const admin = await requireAdminSession(req, app);
      const query = req.query as { limit?: string; cursor?: string };
      const limit = parseLimit(query.limit);
      const cursor = decodeCursor(query.cursor);
      const cursorWhere = cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {};

      const users = await prisma.user.findMany({
        where: cursorWhere,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          role: true,
          trialEndsAt: true,
          trialConsumed: true,
          isPlanMismatch: true,
        },
      });

      const pageUsers = users.slice(0, limit);
      const userIds = pageUsers.map((u) => u.id);
      const activeSubs = userIds.length
        ? await prisma.subscription.findMany({
            where: {
              userId: { in: userIds },
              status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] },
            },
            select: {
              userId: true,
              tier: true,
              status: true,
              currentPeriodEnd: true,
              cancelAtPeriodEnd: true,
              source: true,
              pendingTier: true,
              pendingTierAt: true,
              environment: true,
              createdAt: true,
            },
          })
        : [];
      const userDevices = userIds.length
        ? await prisma.userDevice.findMany({
            where: { userId: { in: userIds } },
            select: { userId: true, platform: true, lastSeenAt: true },
          })
        : [];
      const sessions = userIds.length
        ? await prisma.session.findMany({
            where: { userId: { in: userIds } },
            select: { userId: true, userAgent: true, updatedAt: true },
          })
        : [];

      const subsByUser = new Map<string, typeof activeSubs>();
      for (const sub of activeSubs) {
        const rows = subsByUser.get(sub.userId) ?? [];
        rows.push(sub);
        subsByUser.set(sub.userId, rows);
      }
      const devicesByUser = new Map<string, Array<{ platform: string; lastSeenAt: Date | null }>>();
      for (const device of userDevices) {
        const rows = devicesByUser.get(device.userId) ?? [];
        rows.push({ platform: device.platform, lastSeenAt: device.lastSeenAt });
        devicesByUser.set(device.userId, rows);
      }
      for (const session of sessions) {
        const rows = devicesByUser.get(session.userId) ?? [];
        rows.push({ platform: inferPlatform(session.userAgent), lastSeenAt: session.updatedAt });
        devicesByUser.set(session.userId, rows);
      }

      const runtimeEnv = app.fina.env.APPLE_ENV === "production" ? "production" : "sandbox";
      const rows: AdminUserDTO[] = pageUsers.map((user) =>
        adminUserDTO(
          user,
          subsByUser.get(user.id) ?? [],
          runtimeEnv,
          deviceSummary(devicesByUser.get(user.id) ?? []),
        ),
      );

      const hasMore = users.length > limit;
      const last = pageUsers.at(-1);
      const response: AdminUsersResponse = {
        users: rows,
        nextCursor: hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      };

      app.log.info({ adminUserId: admin.userId, limit, returned: rows.length }, "admin_users_listed");
      return reply.header("Cache-Control", "no-store").send(response);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/admin/users/:userId", async (req, reply) => {
    try {
      const admin = await requireAdminSession(req, app);
      const { userId } = req.params as { userId: string };
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          role: true,
          trialEndsAt: true,
          trialConsumed: true,
          isPlanMismatch: true,
        },
      });
      if (!user) throw new HttpError(404, "not_found");

      const activeSubs = await prisma.subscription.findMany({
        where: {
          userId,
          status: { in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[] },
        },
        select: {
          tier: true,
          status: true,
          currentPeriodEnd: true,
          cancelAtPeriodEnd: true,
          source: true,
          pendingTier: true,
          pendingTierAt: true,
          environment: true,
          createdAt: true,
        },
      });
      const workspaceIds = (await prisma.membership.findMany({
        where: { userId },
        select: { workspaceId: true },
      })).map((m) => m.workspaceId);
      const [
        devices,
        sessions,
        plaidItems,
        transactionAgg,
        lastTransaction,
        chatThreads,
        chatMessageCount,
        totalAi,
        monthlyAi,
      ] = await Promise.all([
        prisma.userDevice.findMany({
          where: { userId },
          orderBy: { lastSeenAt: "desc" },
          take: 10,
          select: { platform: true, lastSeenAt: true, createdAt: true },
        }),
        prisma.session.findMany({
          where: { userId },
          orderBy: { updatedAt: "desc" },
          take: 10,
          select: { userAgent: true, createdAt: true, updatedAt: true, expiresAt: true },
        }),
        prisma.plaidItem.findMany({
          where: { workspaceId: { in: workspaceIds } },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            institutionName: true,
            status: true,
            errorCode: true,
            lastSyncAt: true,
            createdAt: true,
            bankAccounts: {
              orderBy: { createdAt: "desc" },
              select: {
                id: true,
                name: true,
                mask: true,
                type: true,
                subtype: true,
                status: true,
                lastBalanceSyncAt: true,
              },
            },
          },
        }),
        prisma.transaction.aggregate({
          where: { workspaceId: { in: workspaceIds }, removedAt: null },
          _count: true,
        }),
        prisma.transaction.findFirst({
          where: { workspaceId: { in: workspaceIds }, removedAt: null },
          orderBy: { occurredAt: "desc" },
          select: { occurredAt: true },
        }),
        prisma.chatThread.findMany({
          where: { userId },
          select: { id: true, lastMessageAt: true },
        }),
        prisma.chatMessage.count({ where: { thread: { userId } } }),
        prisma.llmCallLog.aggregate({
          where: { userId },
          _count: true,
          _sum: { inputTokens: true, outputTokens: true, costCad: true },
        }),
        prisma.$queryRaw<
          Array<{
            month: string;
            callCount: bigint;
            inputTokens: bigint | null;
            outputTokens: bigint | null;
            costCad: Prisma.Decimal | null;
          }>
        >`
          SELECT
            to_char(date_trunc('month', "createdAt"), 'YYYY-MM') AS "month",
            count(*)::bigint AS "callCount",
            sum("inputTokens")::bigint AS "inputTokens",
            sum("outputTokens")::bigint AS "outputTokens",
            sum("costCad") AS "costCad"
          FROM "llm_call_logs"
          WHERE "userId" = ${userId}
          GROUP BY date_trunc('month', "createdAt")
          ORDER BY date_trunc('month', "createdAt") DESC
        `,
      ]);

      const chatDates = chatThreads.map((t) => t.lastMessageAt);
      const response: AdminUserDetailDTO = {
        user: adminUserDTO(
          user,
          activeSubs,
          app.fina.env.APPLE_ENV === "production" ? "production" : "sandbox",
        ),
        devices: devices.map((d) => ({
          platform: d.platform,
          lastSeenAt: d.lastSeenAt.toISOString(),
          createdAt: d.createdAt.toISOString(),
        })),
        sessions: sessions.map((s) => ({
          platform: inferPlatform(s.userAgent),
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          expiresAt: s.expiresAt.toISOString(),
        })),
        plaidItems: plaidItems.map((item) => ({
          id: item.id,
          institutionName: item.institutionName,
          status: item.status,
          errorCode: item.errorCode,
          lastSyncAt: item.lastSyncAt?.toISOString() ?? null,
          createdAt: item.createdAt.toISOString(),
          accounts: item.bankAccounts.map((account) => ({
            id: account.id,
            name: account.name,
            mask: account.mask,
            type: account.type,
            subtype: account.subtype,
            status: account.status,
            lastBalanceSyncAt: account.lastBalanceSyncAt?.toISOString() ?? null,
          })),
        })),
        activity: {
          lastSeenAt: maxIso([
            ...devices.map((d) => d.lastSeenAt),
            ...sessions.map((s) => s.updatedAt),
            ...chatDates,
            lastTransaction?.occurredAt,
          ]),
          transactionCount: transactionAgg._count,
          lastTransactionAt: lastTransaction?.occurredAt.toISOString() ?? null,
          chatThreadCount: chatThreads.length,
          chatMessageCount,
          lastChatAt: maxIso(chatDates),
        },
        aiUsage: {
          total: {
            callCount: totalAi._count,
            inputTokens: totalAi._sum.inputTokens ?? 0,
            outputTokens: totalAi._sum.outputTokens ?? 0,
            costCad: (totalAi._sum.costCad ?? new Prisma.Decimal(0)).toFixed(6),
          },
          monthly: monthlyAi.map((row) => ({
            month: row.month,
            callCount: Number(row.callCount),
            inputTokens: Number(row.inputTokens ?? 0),
            outputTokens: Number(row.outputTokens ?? 0),
            costCad: (row.costCad ?? new Prisma.Decimal(0)).toFixed(6),
          })),
        },
      };

      app.log.info({ adminUserId: admin.userId, viewedUserId: userId }, "admin_user_detail_viewed");
      return reply.header("Cache-Control", "no-store").send(response);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
