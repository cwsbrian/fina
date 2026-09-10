import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { PutBusinessUseBody } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext, requireWorkspaceKind } from "../auth/context.js";
import { AllocationError } from "../transactions/allocations.js";
import { getBusinessOverview, listBusinessExpenses } from "../business/service.js";

function assertPathWorkspace(pathId: string, headerId: string): void {
  if (pathId !== headerId) throw new HttpError(400, "workspace_mismatch");
}

export async function businessRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string }; Querystring: { yearMonth?: string } }>(
    "/workspaces/:id/business/overview",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
        assertPathWorkspace(req.params.id, ctx.membership.workspaceId);
        await requireWorkspaceKind(ctx.membership.workspaceId, "business");
        const yearMonth = req.query.yearMonth ?? new Date().toISOString().slice(0, 7);
        return { overview: await getBusinessOverview(ctx.membership.workspaceId, yearMonth) };
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        if (e instanceof Error && e.message === "invalid_year_month") return reply.code(400).send({ error: "invalid_year_month" });
        throw e;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { yearMonth?: string; view?: "business" | "review" | "missing" } }>(
    "/workspaces/:id/business/expenses",
    async (req, reply) => {
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
        assertPathWorkspace(req.params.id, ctx.membership.workspaceId);
        await requireWorkspaceKind(ctx.membership.workspaceId, "business");
        const yearMonth = req.query.yearMonth ?? new Date().toISOString().slice(0, 7);
        return { expenses: await listBusinessExpenses(ctx.membership.workspaceId, yearMonth, req.query.view) };
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        if (e instanceof Error && e.message === "invalid_year_month") return reply.code(400).send({ error: "invalid_year_month" });
        throw e;
      }
    },
  );

  app.put<{ Params: { id: string; txId: string } }>(
    "/workspaces/:id/transactions/:txId/business-use",
    async (req, reply) => {
      const parsed = PutBusinessUseBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      try {
        const ctx = await requireWorkspaceContext(req, app, { requiredRole: "editor" });
        assertPathWorkspace(req.params.id, ctx.membership.workspaceId);
        await requireWorkspaceKind(ctx.membership.workspaceId, "business");
        const updated = await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.membership.workspaceId}))`;
          const transaction = await tx.transaction.findFirst({
            where: { id: req.params.txId, workspaceId: ctx.membership.workspaceId, removedAt: null },
          });
          if (!transaction) throw new HttpError(404, "transaction_not_found");
          if (transaction.version !== parsed.data.expectedVersion) {
            throw new HttpError(409, "transaction_changed", undefined, { currentVersion: transaction.version });
          }
          const existingAllocations = await tx.transactionAllocation.findMany({ where: { transactionId: transaction.id } });
          const inputById = new Map(parsed.data.allocations.map((allocation) => [allocation.allocationId, allocation]));
          if (existingAllocations.length !== parsed.data.allocations.length || parsed.data.allocations.some((a) => !a.allocationId) || existingAllocations.some((a) => !inputById.has(a.id))) {
            throw new HttpError(409, "transaction_allocations_changed");
          }
          for (const allocation of existingAllocations) {
            const input = inputById.get(allocation.id)!;
            if (!allocation.amount.equals(input.amount) || allocation.categoryId !== input.categoryId) throw new HttpError(409, "transaction_allocations_changed");
            if (input.businessAmount !== null && new Prisma.Decimal(input.businessAmount).greaterThan(allocation.amount.abs())) throw new HttpError(400, "invalid_business_amount");
          }
          const lineItemIds = parsed.data.allocations.flatMap((a) => a.receiptLineItemId ? [a.receiptLineItemId] : []);
          if (lineItemIds.length) {
            const valid = await tx.receiptLineItem.count({
              where: { id: { in: lineItemIds }, receipt: {
                workspaceId: ctx.membership.workspaceId,
                transactionId: transaction.id,
                verifiedAt: { not: null },
                deletedAt: null,
                status: { in: ["ocr_review", "reviewed"] },
              } },
            });
            if (valid !== new Set(lineItemIds).size) throw new HttpError(400, "receipt_line_item_not_found");
          }
          for (const allocation of existingAllocations) {
            const input = inputById.get(allocation.id)!;
            await tx.transactionAllocation.update({ where: { id: allocation.id }, data: {
              businessAmount: input.businessAmount === null ? null : new Prisma.Decimal(input.businessAmount),
              receiptLineItemId: input.receiptLineItemId ?? null,
            } });
          }
          const updateData: Prisma.TransactionUpdateInput = {
            ...(parsed.data.businessPurpose !== undefined ? { businessPurpose: parsed.data.businessPurpose } : {}),
            ...(parsed.data.receiptMissingReason !== undefined ? { receiptMissingReason: parsed.data.receiptMissingReason } : {}),
            ...(parsed.data.receiptMissingNote !== undefined ? { receiptMissingNote: parsed.data.receiptMissingNote } : {}),
          };
          return await tx.transaction.update({
            where: { id: transaction.id },
            data: { ...updateData, version: { increment: 1 } },
            include: { allocations: true },
          });
        });
        return { transaction: { id: updated.id, version: updated.version, allocations: updated.allocations.map((a) => ({
          id: a.id, categoryId: a.categoryId, amount: a.amount.toFixed(2), businessAmount: a.businessAmount?.toFixed(2) ?? null, receiptLineItemId: a.receiptLineItemId,
        })) } };
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code, details: e.details });
        if (e instanceof AllocationError) return reply.code(400).send({ error: e.code });
        throw e;
      }
    },
  );
}
