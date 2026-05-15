import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { applyManualCategorize, ManualCategorizeError } from "../categorize/manual-categorize.js";

// `?from`/`?to` arrive as ISO date strings. We validate them as parseable
// dates BEFORE handing them to `new Date(...)` — otherwise an invalid input
// like `?from=foo` would explode at runtime instead of returning 400.
const IsoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: "must be ISO date",
});

// `z.coerce.boolean()` is broken for query strings: `Boolean("false")` is
// truthy, so `?includeRemoved=false` would include them. Parse the raw
// string explicitly.
const BoolFlag = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional()
  .default("false");

const QuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  accountId: z.string().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  includeRemoved: BoolFlag,
  uncategorizedOnly: BoolFlag,
});

type Cursor = { occurredAtMs: number; id: string };
function decodeCursor(s: string | undefined): Cursor | null {
  if (!s) return null;
  try {
    const obj = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    if (typeof obj.occurredAtMs === "number" && typeof obj.id === "string") return obj;
  } catch {
    // ignore — treat as no cursor
  }
  return null;
}
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export async function transactionsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/workspaces/:id/transactions", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const q = parsed.data;
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const cursor = decodeCursor(q.cursor);
      const where = {
        workspaceId: ctx.membership.workspaceId,
        ...(q.accountId ? { accountId: q.accountId } : {}),
        // Build the date range in one pass — the previous two-spread approach
        // relied on the second spread silently overwriting the first when both
        // from+to were present, which is correct but confusing to read.
        ...(() => {
          if (q.from && q.to)  return { occurredAt: { gte: new Date(q.from), lte: new Date(q.to) } };
          if (q.from)          return { occurredAt: { gte: new Date(q.from) } };
          if (q.to)            return { occurredAt: { lte: new Date(q.to) } };
          return {};
        })(),
        ...(q.includeRemoved ? {} : { removedAt: null }),
        ...(q.uncategorizedOnly ? { categoryId: null } : {}),
        ...(cursor
          ? {
              OR: [
                { occurredAt: { lt: new Date(cursor.occurredAtMs) } },
                {
                  AND: [
                    { occurredAt: new Date(cursor.occurredAtMs) },
                    { id: { lt: cursor.id } }, // tie-breaker by id
                  ],
                },
              ],
            }
          : {}),
      };
      const rows = await prisma.transaction.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: q.limit + 1,
      });
      const hasMore = rows.length > q.limit;
      const page = hasMore ? rows.slice(0, q.limit) : rows;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last
        ? encodeCursor({ occurredAtMs: last.occurredAt.getTime(), id: last.id })
        : null;
      return {
        transactions: page.map((t) => ({
          id: t.id,
          accountId: t.accountId,
          plaidTransactionId: t.plaidTransactionId,
          amount: t.amount.toString(),
          currency: t.currency,
          merchantRaw: t.merchantRaw,
          merchantNormalized: t.merchantNormalized,
          categoryId: t.categoryId,
          occurredAt: t.occurredAt.toISOString(),
          postedAt: t.postedAt?.toISOString() ?? null,
          pending: t.pending,
          source: t.source,
          note: t.note,
          removedAt: t.removedAt?.toISOString() ?? null,
        })),
        nextCursor,
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  const CategorizeBody = z.object({ categoryName: z.string().trim().min(1).max(80) });

  app.post("/workspaces/:id/transactions/:txId/categorize", async (req, reply) => {
    const params = req.params as { id: string; txId: string };
    const parsed = CategorizeBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const result = await applyManualCategorize({
        workspaceId: ctx.membership.workspaceId,
        txId: params.txId,
        categoryName: parsed.data.categoryName,
      });
      return {
        transaction: {
          ...result.tx,
          amount: result.tx.amount,
          occurredAt: result.tx.occurredAt.toISOString(),
        },
        backfilledCount: result.backfilledCount,
      };
    } catch (e) {
      if (e instanceof ManualCategorizeError) {
        if (e.code === "tx_not_found") return reply.code(404).send({ error: "not_found" });
        if (e.code === "category_not_found") return reply.code(404).send({ error: "category_not_found" });
      }
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
