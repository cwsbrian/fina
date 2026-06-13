import type { FastifyInstance } from "fastify";
import type { $Enums } from "@prisma/client";
import {
  ACTIVE_SUBSCRIPTION_STATUSES,
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

      const subsByUser = new Map<string, typeof activeSubs>();
      for (const sub of activeSubs) {
        const rows = subsByUser.get(sub.userId) ?? [];
        rows.push(sub);
        subsByUser.set(sub.userId, rows);
      }

      const runtimeEnv = app.fina.env.APPLE_ENV === "production" ? "production" : "sandbox";
      const rows: AdminUserDTO[] = pageUsers.map((user) => {
        const filtered = filterEnvironmentRows(subsByUser.get(user.id) ?? [], runtimeEnv);
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
          activeSubscriptionCount: filtered.length,
          isPlanMismatch: user.isPlanMismatch,
        };
      });

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
}
