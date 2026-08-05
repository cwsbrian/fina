import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma, type $Enums } from "@prisma/client";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
  type AdminChatMessagesResponse,
  type AdminChatThreadsResponse,
  type AdminTransactionsResponse,
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Cursor = {
  createdAt: string;
  id: string;
};

type EnvironmentFilter = "production" | "test" | "unknown" | "all";

function parseEnvironmentFilter(value: unknown): EnvironmentFilter {
  if (value === undefined) return "production";
  if (value === "production" || value === "test" || value === "unknown" || value === "all") {
    return value;
  }
  throw new HttpError(400, "invalid_query");
}

function signupEnvironmentWhere(filter: EnvironmentFilter): Prisma.UserWhereInput {
  if (filter === "all") return {};
  return { signupEnvironment: filter.toUpperCase() as $Enums.SignupEnvironment };
}

function subscriptionRuntimeEnvironment(
  signupEnvironment: $Enums.SignupEnvironment,
): "sandbox" | "production" {
  return signupEnvironment === "TEST" ? "sandbox" : "production";
}

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

async function ensureUserExists(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new HttpError(404, "not_found");
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
  const times = values.filter((v): v is Date => v instanceof Date).map((v) => v.getTime());
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

function auditRequestId(req: FastifyRequest): string {
  const value = req.headers["x-request-id"];
  return typeof value === "string" && UUID_RE.test(value) ? value : req.id;
}

function adminUserDTO(
  user: {
    id: string;
    email: string;
    name: string | null;
    createdAt: Date;
    role: $Enums.UserRole;
    signupEnvironment: $Enums.SignupEnvironment;
    signupPlatform: string | null;
    signupBuildNumber: string | null;
    appleStoreEnvironment: string | null;
    environmentVerifiedAt: Date | null;
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
  devices: AdminUserDTO["deviceSummary"] = [],
): AdminUserDTO {
  const filtered = filterEnvironmentRows(
    subs,
    subscriptionRuntimeEnvironment(user.signupEnvironment),
  );
  const tier = computeEffectiveTier(user, filtered);
  const primary = pickPrimarySub(filtered);
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
    role: user.role,
    signupEnvironment: user.signupEnvironment,
    signupPlatform: user.signupPlatform,
    signupBuildNumber: user.signupBuildNumber,
    appleStoreEnvironment: user.appleStoreEnvironment,
    environmentVerifiedAt: user.environmentVerifiedAt?.toISOString() ?? null,
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

function adminUsersSummary(
  users: Array<{
    trialEndsAt: Date | null;
    signupEnvironment: $Enums.SignupEnvironment;
    subscriptions: Array<{ tier: string; environment: string }>;
  }>,
): AdminUsersResponse["summary"] {
  const summary: AdminUsersResponse["summary"] = {
    userCount: users.length,
    proUserCount: 0,
    maxUserCount: 0,
    activeTrialCount: 0,
  };

  for (const user of users) {
    const subscriptions = filterEnvironmentRows(
      user.subscriptions,
      subscriptionRuntimeEnvironment(user.signupEnvironment),
    );
    const tier = computeEffectiveTier(user, subscriptions);
    if (tier.tier === "pro") summary.proUserCount += 1;
    if (tier.tier === "max") summary.maxUserCount += 1;
    if (tier.trialActive) summary.activeTrialCount += 1;
  }

  return summary;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const listUsers = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = req.query as { limit?: string; cursor?: string; environment?: string };
      const limit = parseLimit(query.limit);
      const cursor = decodeCursor(query.cursor);
      const environment = parseEnvironmentFilter(query.environment);
      const environmentWhere = signupEnvironmentWhere(environment);
      const cursorWhere = cursor
        ? {
            OR: [
              { createdAt: { lt: new Date(cursor.createdAt) } },
              { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
            ],
          }
        : {};

      const [users, summaryUsers] = await Promise.all([
        prisma.user.findMany({
          where: { ...cursorWhere, ...environmentWhere },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: limit + 1,
          select: {
            id: true,
            email: true,
            name: true,
            createdAt: true,
            role: true,
            signupEnvironment: true,
            signupPlatform: true,
            signupBuildNumber: true,
            appleStoreEnvironment: true,
            environmentVerifiedAt: true,
            trialEndsAt: true,
            trialConsumed: true,
            isPlanMismatch: true,
          },
        }),
        prisma.user.findMany({
          where: environmentWhere,
          select: {
            trialEndsAt: true,
            signupEnvironment: true,
            subscriptions: {
              where: {
                status: {
                  in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[],
                },
              },
              select: { tier: true, environment: true },
            },
          },
        }),
      ]);

      const pageUsers = users.slice(0, limit);
      const userIds = pageUsers.map((u) => u.id);
      const activeSubs = userIds.length
        ? await prisma.subscription.findMany({
            where: {
              userId: { in: userIds },
              status: {
                in: ACTIVE_SUBSCRIPTION_STATUSES as unknown as $Enums.SubscriptionStatus[],
              },
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

      const rows: AdminUserDTO[] = pageUsers.map((user) =>
        adminUserDTO(
          user,
          subsByUser.get(user.id) ?? [],
          deviceSummary(devicesByUser.get(user.id) ?? []),
        ),
      );

      const hasMore = users.length > limit;
      const last = pageUsers.at(-1);
      const response: AdminUsersResponse = {
        users: rows,
        nextCursor:
          hasMore && last
            ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
            : null,
        summary: adminUsersSummary(summaryUsers),
      };

      const result = reply.send(response);
      return { result, returned: rows.length };
    } catch (e) {
      throw e;
    }
  };

  const userDetail = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const { userId } = req.params as { userId: string };
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          role: true,
          signupEnvironment: true,
          signupPlatform: true,
          signupBuildNumber: true,
          appleStoreEnvironment: true,
          environmentVerifiedAt: true,
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
      const workspaceIds = (
        await prisma.membership.findMany({
          where: { userId },
          select: { workspaceId: true },
        })
      ).map((m) => m.workspaceId);
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
          where: {
            workspaceId: { in: workspaceIds },
            billingGraceHiddenAt: null,
            removedAt: null,
          },
          _count: true,
        }),
        prisma.transaction.findFirst({
          where: {
            workspaceId: { in: workspaceIds },
            billingGraceHiddenAt: null,
            removedAt: null,
          },
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
        user: adminUserDTO(user, activeSubs),
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

      return reply.send(response);
    } catch (e) {
      throw e;
    }
  };

  const userTransactions = async (req: FastifyRequest, reply: FastifyReply) => {
    const { userId } = req.params as { userId: string };
    const query = req.query as { limit?: string; cursor?: string };
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    await ensureUserExists(userId);

    const transactions = await prisma.transaction.findMany({
      where: {
        workspace: { memberships: { some: { userId } } },
        billingGraceHiddenAt: null,
        removedAt: null,
        ...(cursor
          ? {
              OR: [
                { occurredAt: { lt: new Date(cursor.createdAt) } },
                { occurredAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: {
        id: true,
        amount: true,
        merchantRaw: true,
        occurredAt: true,
        pending: true,
        source: true,
        note: true,
        removedAt: true,
        budgetImpact: true,
        workspace: { select: { id: true, name: true, currency: true } },
        account: { select: { id: true, name: true, mask: true } },
        allocations: {
          orderBy: { createdAt: "asc" },
          select: {
            amount: true,
            category: { select: { name: true } },
          },
        },
      },
    });
    const page = transactions.slice(0, limit);
    const last = page.at(-1);
    const response: AdminTransactionsResponse = {
      transactions: page.map((transaction) => ({
        id: transaction.id,
        workspace: {
          id: transaction.workspace.id,
          name: transaction.workspace.name,
        },
        account: transaction.account,
        amount: transaction.amount.toFixed(2),
        currency: transaction.workspace.currency,
        merchantRaw: transaction.merchantRaw,
        occurredAt: transaction.occurredAt.toISOString(),
        pending: transaction.pending,
        source: transaction.source,
        note: transaction.note,
        removedAt: transaction.removedAt?.toISOString() ?? null,
        budgetImpact: transaction.budgetImpact,
        allocations: transaction.allocations.map((allocation) => ({
          amount: allocation.amount.toFixed(2),
          categoryName: allocation.category?.name ?? null,
        })),
      })),
      nextCursor:
        transactions.length > limit && last
          ? encodeCursor({ createdAt: last.occurredAt.toISOString(), id: last.id })
          : null,
    };
    return reply.send(response);
  };

  const userChatThreads = async (req: FastifyRequest, reply: FastifyReply) => {
    const { userId } = req.params as { userId: string };
    await ensureUserExists(userId);
    const threads = await prisma.chatThread.findMany({
      where: { userId },
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        lastMessageAt: true,
        archivedAt: true,
        createdAt: true,
        workspace: { select: { id: true, name: true } },
        _count: { select: { messages: true } },
      },
    });
    const response: AdminChatThreadsResponse = {
      threads: threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        workspace: thread.workspace,
        lastMessageAt: thread.lastMessageAt?.toISOString() ?? null,
        archivedAt: thread.archivedAt?.toISOString() ?? null,
        createdAt: thread.createdAt.toISOString(),
        messageCount: thread._count.messages,
      })),
    };
    return reply.send(response);
  };

  const userChatMessages = async (req: FastifyRequest, reply: FastifyReply) => {
    const { userId, threadId } = req.params as { userId: string; threadId: string };
    const query = req.query as { limit?: string; cursor?: string };
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    const thread = await prisma.chatThread.findFirst({
      where: { id: threadId, userId },
      select: { id: true },
    });
    if (!thread) throw new HttpError(404, "not_found");

    const messages = await prisma.chatMessage.findMany({
      where: {
        threadId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: { id: true, role: true, blocks: true, createdAt: true },
    });
    const page = messages.slice(0, limit);
    const oldest = page.at(-1);
    const response: AdminChatMessagesResponse = {
      threadId,
      messages: page.reverse().map((message) => ({
        id: message.id,
        role: message.role,
        blocks: message.blocks,
        createdAt: message.createdAt.toISOString(),
      })),
      nextCursor:
        messages.length > limit && oldest
          ? encodeCursor({ createdAt: oldest.createdAt.toISOString(), id: oldest.id })
          : null,
    };
    return reply.send(response);
  };

  const logInternalAudit = (
    req: FastifyRequest,
    startedAt: number,
    action:
      | "admin_users_listed"
      | "admin_user_detail_viewed"
      | "admin_user_transactions_viewed"
      | "admin_user_chat_threads_viewed"
      | "admin_user_chat_messages_viewed",
    outcome: "success" | "failure",
    status: number,
    adminSubject?: string,
    returned?: number,
  ) => {
    app.log.info(
      {
        requestId: auditRequestId(req),
        ...(adminSubject === undefined ? {} : { adminSubject }),
        action,
        outcome,
        status,
        ...(returned === undefined ? {} : { returned }),
        latencyMs: Math.max(0, Date.now() - startedAt),
      },
      "internal_admin_audit",
    );
  };

  app.get("/internal/admin/users", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const startedAt = Date.now();
    let adminSubject: string | undefined;
    try {
      const actor = await app.fina.verifyAdminToken(req.headers.authorization);
      adminSubject = actor.sub;
      const { result, returned } = await listUsers(req, reply);
      logInternalAudit(
        req,
        startedAt,
        "admin_users_listed",
        "success",
        200,
        adminSubject,
        returned,
      );
      return result;
    } catch (e) {
      const status = e instanceof HttpError ? e.statusCode : 500;
      logInternalAudit(req, startedAt, "admin_users_listed", "failure", status, adminSubject);
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/internal/admin/users/:userId", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const startedAt = Date.now();
    let adminSubject: string | undefined;
    try {
      const actor = await app.fina.verifyAdminToken(req.headers.authorization);
      adminSubject = actor.sub;
      const result = await userDetail(req, reply);
      logInternalAudit(req, startedAt, "admin_user_detail_viewed", "success", 200, adminSubject);
      return result;
    } catch (e) {
      const status = e instanceof HttpError ? e.statusCode : 500;
      logInternalAudit(req, startedAt, "admin_user_detail_viewed", "failure", status, adminSubject);
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/internal/admin/users/:userId/transactions", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const startedAt = Date.now();
    let adminSubject: string | undefined;
    try {
      const actor = await app.fina.verifyAdminToken(req.headers.authorization);
      adminSubject = actor.sub;
      const result = await userTransactions(req, reply);
      logInternalAudit(
        req,
        startedAt,
        "admin_user_transactions_viewed",
        "success",
        200,
        adminSubject,
      );
      return result;
    } catch (e) {
      const status = e instanceof HttpError ? e.statusCode : 500;
      logInternalAudit(
        req,
        startedAt,
        "admin_user_transactions_viewed",
        "failure",
        status,
        adminSubject,
      );
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/internal/admin/users/:userId/chat-threads", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const startedAt = Date.now();
    let adminSubject: string | undefined;
    try {
      const actor = await app.fina.verifyAdminToken(req.headers.authorization);
      adminSubject = actor.sub;
      const result = await userChatThreads(req, reply);
      logInternalAudit(
        req,
        startedAt,
        "admin_user_chat_threads_viewed",
        "success",
        200,
        adminSubject,
      );
      return result;
    } catch (e) {
      const status = e instanceof HttpError ? e.statusCode : 500;
      logInternalAudit(
        req,
        startedAt,
        "admin_user_chat_threads_viewed",
        "failure",
        status,
        adminSubject,
      );
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/internal/admin/users/:userId/chat-threads/:threadId/messages", async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    const startedAt = Date.now();
    let adminSubject: string | undefined;
    try {
      const actor = await app.fina.verifyAdminToken(req.headers.authorization);
      adminSubject = actor.sub;
      const result = await userChatMessages(req, reply);
      logInternalAudit(
        req,
        startedAt,
        "admin_user_chat_messages_viewed",
        "success",
        200,
        adminSubject,
      );
      return result;
    } catch (e) {
      const status = e instanceof HttpError ? e.statusCode : 500;
      logInternalAudit(
        req,
        startedAt,
        "admin_user_chat_messages_viewed",
        "failure",
        status,
        adminSubject,
      );
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/admin/users", async (req, reply) => {
    try {
      await requireAdminSession(req, app);
      return (await listUsers(req, reply)).result;
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get("/admin/users/:userId", async (req, reply) => {
    try {
      await requireAdminSession(req, app);
      return await userDetail(req, reply);
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
