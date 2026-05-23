import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext } from "../auth/context.js";
import { applyManualCategorize, ManualCategorizeError } from "../categorize/manual-categorize.js";
import {
  createManualTransactionService,
  CreateManualTxError,
  type CreateManualTxInput,
} from "../transactions/create-manual.js";
import { editTransactionService, EditTxError, type EditTxInput, type EditTxInputFlags } from "../transactions/edit.js";
import { removeTransactionService, RemoveTxError } from "../transactions/remove.js";

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

const PatchTxBody = z
  .object({
    amount: z.number().optional(),
    merchantRaw: z.string().optional(),
    occurredAt: z.string().optional(),
    note: z.string().nullable().optional(),
    categoryId: z.string().nullable().optional(),
    allocations: z
      .array(z.object({
        categoryId: z.string().nullable(),
        amount: z.number(),
      }))
      .optional(),
    accountId: z.string().optional(),
  })
  .strict();

const ManualTxBody = z.object({
  merchantRaw: z.string(),
  amount: z.number(),
  occurredAt: z.string().optional(),
  categoryId: z.string().optional(),
  note: z.string().optional(),
  accountId: z.string().optional(),
});

const QuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  accountId: z.string().optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  includeRemoved: BoolFlag,
  uncategorizedOnly: BoolFlag,
  categoryId: z.string().optional(),
  /** Free-text search across merchantRaw + merchantNormalized
   *  (case-insensitive substring). 1-character min keeps trivial
   *  full-table-scan queries out. */
  q: z.string().trim().min(1).max(120).optional(),
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

function editTxErrorStatus(code: EditTxError["code"]): number {
  if (
    code === "not_found"
    || code === "category_not_found"
    || code === "account_not_found"
  ) return 404;
  return 400; // not_editable | already_removed | cannot_split_pending |
              // conflicting_body | sum_mismatch | empty_allocations | invalid_*
}

function removeTxErrorStatus(code: RemoveTxError["code"]): number {
  if (code === "not_found") return 404;
  return 400; // cannot_delete_pending
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
      const workspace = await prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.membership.workspaceId },
        select: { currency: true },
      });
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
        ...(q.q
          ? {
              OR: [
                { merchantRaw: { contains: q.q, mode: "insensitive" as const } },
                { merchantNormalized: { contains: q.q, mode: "insensitive" as const } },
              ],
            }
          : {}),
        ...(() => {
          if (q.uncategorizedOnly && q.categoryId) {
            return { allocations: { some: { OR: [{ categoryId: null }, { categoryId: q.categoryId }] } } };
          }
          if (q.uncategorizedOnly) return { allocations: { some: { categoryId: null } } };
          if (q.categoryId)        return { allocations: { some: { categoryId: q.categoryId } } };
          return {};
        })(),
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
        include: {
          allocations: {
            select: { id: true, categoryId: true, amount: true, source: true },
            orderBy: { createdAt: "asc" },
          },
        },
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
          currency: workspace.currency,
          merchantRaw: t.merchantRaw,
          merchantNormalized: t.merchantNormalized,
          occurredAt: t.occurredAt.toISOString(),
          postedAt: t.postedAt?.toISOString() ?? null,
          pending: t.pending,
          source: t.source,
          note: t.note,
          removedAt: t.removedAt?.toISOString() ?? null,
          needsReclassification: t.needsReclassification,
          allocations: t.allocations.map((a) => ({
            id: a.id,
            categoryId: a.categoryId,
            amount: a.amount.toString(),
            source: a.source,
          })),
        })),
        nextCursor,
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.get<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const [workspace, t] = await Promise.all([
          prisma.workspace.findUniqueOrThrow({
            where: { id: ctx.membership.workspaceId },
            select: { currency: true },
          }),
          prisma.transaction.findFirst({
            where: { id: req.params.txId, workspaceId: ctx.membership.workspaceId },
            include: {
              allocations: {
                select: { id: true, categoryId: true, amount: true, source: true },
                orderBy: { createdAt: "asc" },
              },
            },
          }),
        ]);
        if (!t) return reply.code(404).send({ error: "not_found" });
        return reply.code(200).send({
          transaction: {
            id: t.id,
            accountId: t.accountId,
            plaidTransactionId: t.plaidTransactionId,
            amount: t.amount.toString(),
            currency: workspace.currency,
            merchantRaw: t.merchantRaw,
            merchantNormalized: t.merchantNormalized,
            occurredAt: t.occurredAt.toISOString(),
            postedAt: t.postedAt?.toISOString() ?? null,
            pending: t.pending,
            source: t.source,
            note: t.note,
            removedAt: t.removedAt?.toISOString() ?? null,
            needsReclassification: t.needsReclassification,
            allocations: t.allocations.map((a) => ({
              id: a.id,
              categoryId: a.categoryId,
              amount: a.amount.toString(),
              source: a.source,
            })),
          },
        });
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        throw err;
      }
    },
  );

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

  app.post<{ Params: { id: string } }>(
    "/workspaces/:id/transactions/manual",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const parsed = ManualTxBody.safeParse(req.body);
        if (!parsed.success) {
          return reply.code(400).send({ error: "invalid_body" });
        }
        const d = parsed.data;
        const input: CreateManualTxInput = { merchantRaw: d.merchantRaw, amount: d.amount };
        if (d.occurredAt !== undefined) input.occurredAt = d.occurredAt;
        if (d.categoryId !== undefined) input.categoryId = d.categoryId;
        if (d.note       !== undefined) input.note       = d.note;
        if (d.accountId  !== undefined) input.accountId  = d.accountId;
        const result = await createManualTransactionService(
          { workspaceId: ctx.membership.workspaceId, userId: ctx.session.userId },
          input,
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof HttpError) {
          return reply.code(err.statusCode).send({ error: err.code });
        }
        if (err instanceof CreateManualTxError) {
          const status = err.code.startsWith("invalid_") ? 400 : 404;
          return reply.code(status).send({ error: err.code });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const body = (req.body as Record<string, unknown>) ?? {};
        const parsed = PatchTxBody.safeParse(body);
        if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
        const flags: EditTxInputFlags = {
          manualOnlyFieldProvided:
            "amount" in body
            || "merchantRaw" in body
            || "occurredAt" in body
            || "note" in body
            || "accountId" in body,
          categoryIdProvided: "categoryId" in body,
          allocationsProvided: "allocations" in body,
        };
        const d = parsed.data;
        const input: EditTxInput = {};
        if (d.amount       !== undefined) input.amount       = d.amount;
        if (d.merchantRaw  !== undefined) input.merchantRaw  = d.merchantRaw;
        if (d.occurredAt   !== undefined) input.occurredAt   = d.occurredAt;
        if (d.note         !== undefined) input.note         = d.note;
        if (d.accountId    !== undefined) input.accountId    = d.accountId;
        if (flags.categoryIdProvided)     input.categoryId   = d.categoryId ?? null;
        if (flags.allocationsProvided)    input.allocations  = d.allocations ?? [];
        const result = await editTransactionService(
          { workspaceId: ctx.membership.workspaceId },
          req.params.txId,
          input,
          flags,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        if (err instanceof EditTxError) return reply.code(editTxErrorStatus(err.code)).send({ error: err.code });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        if (req.params.id !== ctx.membership.workspaceId) {
          return reply.code(400).send({ error: "workspace_mismatch" });
        }
        const result = await removeTransactionService(
          { workspaceId: ctx.membership.workspaceId },
          req.params.txId,
        );
        return reply.code(200).send(result);
      } catch (err) {
        if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code });
        if (err instanceof RemoveTxError) return reply.code(removeTxErrorStatus(err.code)).send({ error: err.code });
        throw err;
      }
    },
  );
}
