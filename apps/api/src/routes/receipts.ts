import { randomUUID } from "node:crypto";
import { Prisma, type ReceiptDocument, type ReceiptLineItem } from "@prisma/client";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ApplyReceiptBody,
  CompleteReceiptUploadBody,
  CreateReceiptUploadIntentBody,
  CreateTransactionFromReceiptBody,
  LinkReceiptBody,
  PatchReceiptBody,
  type ReceiptDocumentDTO,
} from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireWorkspaceContext, requireWorkspaceKind } from "../auth/context.js";
import { receiptStorageLocation } from "../business/evidence.js";
import { CloudflareR2ReceiptInfrastructure, ReceiptInfrastructureError, type ReceiptStorageLocation } from "../receipts/storage.js";
import { createManualTransactionService, CreateManualTxError } from "../transactions/create-manual.js";
import { applyAllocations, AllocationError } from "../transactions/allocations.js";
import { logAuditEvent } from "../audit/service.js";
import { allocateProportionalCents } from "../business/proportional.js";

type ReceiptWithItems = ReceiptDocument & { lineItems: ReceiptLineItem[] };

function receiptDto(receipt: ReceiptWithItems): ReceiptDocumentDTO {
  return {
    id: receipt.id,
    transactionId: receipt.transactionId,
    role: receipt.role,
    status: receipt.status,
    originalName: receipt.originalName,
    mimeType: receipt.mimeType,
    byteSize: receipt.byteSize,
    pageCount: receipt.pageCount,
    sha256: receipt.sha256,
    verifiedAt: receipt.verifiedAt?.toISOString() ?? null,
    merchantName: receipt.merchantName,
    receiptDate: receipt.receiptDate?.toISOString() ?? null,
    totalAmount: receipt.totalAmount?.toFixed(2) ?? null,
    currency: receipt.currency,
    lineItems: receipt.lineItems.map((item) => ({
      id: item.id,
      description: item.editedDescription ?? item.description,
      quantity: (item.editedQuantity ?? item.quantity)?.toString() ?? null,
      unitPrice: (item.editedUnitPrice ?? item.unitPrice)?.toFixed(2) ?? null,
      lineTotal: (item.editedLineTotal ?? item.lineTotal).toFixed(2),
      confidence: item.confidence?.toNumber() ?? null,
      page: item.page,
      boundingBox: item.boundingBox,
      categoryId: item.categoryId,
    })),
    createdAt: receipt.createdAt.toISOString(),
  };
}

async function receiptForWorkspace(workspaceId: string, receiptId: string): Promise<ReceiptWithItems> {
  const receipt = await prisma.receiptDocument.findFirst({
    where: { id: receiptId, workspaceId, deletedAt: null },
    include: { lineItems: { orderBy: [{ page: "asc" }, { createdAt: "asc" }] } },
  });
  if (!receipt) throw new HttpError(404, "receipt_not_found");
  return receipt;
}

function mapError(reply: FastifyReply, error: unknown) {
  if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.code, details: error.details });
  if (error instanceof ReceiptInfrastructureError) {
    const status = error.code === "receipt_storage_unavailable" ? 503 : 400;
    return reply.code(status).send({ error: error.code });
  }
  if (error instanceof AllocationError || error instanceof CreateManualTxError) {
    return reply.code(400).send({ error: error.code });
  }
  throw error;
}

async function context(req: Parameters<typeof requireWorkspaceContext>[0], app: FastifyInstance, id: string, role: "viewer" | "editor" | "owner") {
  const ctx = await requireWorkspaceContext(req, app, { requiredRole: role });
  if (ctx.membership.workspaceId !== id) throw new HttpError(400, "workspace_mismatch");
  await requireWorkspaceKind(id, "business");
  return ctx;
}

function proportionalCents(lineItems: ReceiptLineItem[], transactionCents: number): Map<string, number> {
  const positive = lineItems.map((line) => ({
    id: line.id,
    cents: Math.round((line.editedLineTotal ?? line.lineTotal).toNumber() * 100),
  }));
  try { return allocateProportionalCents(positive, transactionCents); }
  catch { throw new HttpError(400, "receipt_has_no_line_total"); }
}

export async function receiptsRoutes(app: FastifyInstance): Promise<void> {
  const infrastructure = new CloudflareR2ReceiptInfrastructure(app.fina.env);

  app.post<{ Params: { id: string } }>("/workspaces/:id/receipts/upload-intents", async (req, reply) => {
    const parsed = CreateReceiptUploadIntentBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await context(req, app, req.params.id, "editor");
      const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: req.params.id }, select: { taxCountry: true } });
      const activeUploads = await prisma.receiptDocument.count({
        where: { workspaceId: req.params.id, deletedAt: null, status: { in: ["uploading", "queued", "processing"] } },
      });
      if (activeUploads >= 10) throw new HttpError(429, "receipt_upload_limit_reached");
      const monthUploads = await prisma.receiptDocument.count({
        where: { workspaceId: req.params.id, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
      });
      if (monthUploads >= 500) throw new HttpError(429, "receipt_monthly_limit_reached");
      if (parsed.data.transactionId) {
        const exists = await prisma.transaction.count({ where: { id: parsed.data.transactionId, workspaceId: req.params.id, removedAt: null, pending: false, budgetImpact: "expense" } });
        if (!exists) throw new HttpError(404, "transaction_not_found");
      }
      if (parsed.data.supersedesReceiptId) {
        await receiptForWorkspace(req.params.id, parsed.data.supersedesReceiptId);
      }
      const id = randomUUID();
      const location = receiptStorageLocation(workspace.taxCountry);
      const upload = await infrastructure.createUpload({
        workspaceId: req.params.id,
        receiptId: id,
        location,
        mimeType: parsed.data.mimeType,
        byteSize: parsed.data.byteSize,
      });
      const receipt = await prisma.receiptDocument.create({
        data: {
          id,
          workspaceId: req.params.id,
          ...(parsed.data.transactionId ? { transactionId: parsed.data.transactionId } : {}),
          role: parsed.data.role,
          originalName: parsed.data.originalName,
          mimeType: parsed.data.mimeType,
          byteSize: parsed.data.byteSize,
          ...(parsed.data.pageCount ? { pageCount: parsed.data.pageCount } : {}),
          storageRegion: location,
          storageBucket: upload.bucket,
          storageKey: upload.key,
          ...(parsed.data.sha256 ? { sha256: parsed.data.sha256 } : {}),
          uploadedById: ctx.session.userId,
        },
      });
      if (parsed.data.supersedesReceiptId) {
        await prisma.receiptDocument.update({
          where: { id: parsed.data.supersedesReceiptId },
          data: { supersededById: receipt.id },
        });
      }
      return reply.code(201).send({ receiptId: receipt.id, uploadUrl: upload.uploadUrl, headers: upload.headers, expiresInSeconds: 300 });
    } catch (error) { return mapError(reply, error); }
  });

  app.post<{ Params: { id: string; receiptId: string } }>("/workspaces/:id/receipts/:receiptId/complete", async (req, reply) => {
    const parsed = CompleteReceiptUploadBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await context(req, app, req.params.id, "editor");
      const receipt = await receiptForWorkspace(req.params.id, req.params.receiptId);
      if (receipt.status !== "uploading") return reply.code(200).send({ receipt: receiptDto(receipt) });
      if (receipt.byteSize !== parsed.data.byteSize) throw new HttpError(400, "receipt_file_mismatch");
      let verified: { pageCount: number };
      try {
        verified = await infrastructure.verify({
          location: receipt.storageRegion as ReceiptStorageLocation,
          bucket: receipt.storageBucket,
          key: receipt.storageKey,
          byteSize: receipt.byteSize,
          mimeType: receipt.mimeType,
          sha256: parsed.data.sha256,
        });
      } catch (error) {
        if (error instanceof ReceiptInfrastructureError && error.code !== "receipt_storage_unavailable") {
          await infrastructure.deleteObject({ location: receipt.storageRegion as ReceiptStorageLocation, bucket: receipt.storageBucket, key: receipt.storageKey });
          await prisma.receiptDocument.updateMany({ where: { id: receipt.id, status: "uploading" }, data: { status: "failed", ocrError: error.code } });
        }
        throw error;
      }
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.receiptDocument.updateMany({
          where: { id: receipt.id, status: "uploading", deletedAt: null },
          data: { sha256: parsed.data.sha256, verifiedAt: new Date(), pageCount: verified.pageCount, status: "queued" },
        });
        if (claimed.count !== 1) throw new HttpError(409, "receipt_upload_already_completed");
        await tx.receiptDocument.updateMany({
          where: { supersededById: receipt.id },
          data: { status: "superseded", transactionId: null },
        });
      });
      try {
        await infrastructure.enqueue({ location: receipt.storageRegion as ReceiptStorageLocation, receiptId: receipt.id });
      } catch (error) {
        await prisma.receiptDocument.update({ where: { id: receipt.id }, data: { status: "failed", ocrError: "queue_failed" } });
        throw error;
      }
      return reply.code(202).send({ receipt: receiptDto(await receiptForWorkspace(req.params.id, receipt.id)) });
    } catch (error) { return mapError(reply, error); }
  });

  app.get<{ Params: { id: string; txId: string } }>("/workspaces/:id/transactions/:txId/receipts", async (req, reply) => {
    try {
      await context(req, app, req.params.id, "viewer");
      const receipts = await prisma.receiptDocument.findMany({
        where: { workspaceId: req.params.id, transactionId: req.params.txId, deletedAt: null },
        include: { lineItems: { orderBy: [{ page: "asc" }, { createdAt: "asc" }] } },
        orderBy: { createdAt: "desc" },
      });
      return { receipts: receipts.map(receiptDto) };
    } catch (error) { return mapError(reply, error); }
  });

  app.get<{ Params: { id: string; receiptId: string } }>("/workspaces/:id/receipts/:receiptId", async (req, reply) => {
    try {
      await context(req, app, req.params.id, "viewer");
      const receipt = await receiptForWorkspace(req.params.id, req.params.receiptId);
      const downloadUrl = await infrastructure.downloadUrl({ location: receipt.storageRegion as ReceiptStorageLocation, bucket: receipt.storageBucket, key: receipt.storageKey });
      return { receipt: receiptDto(receipt), downloadUrl, expiresInSeconds: 300 };
    } catch (error) { return mapError(reply, error); }
  });

  app.patch<{ Params: { id: string; receiptId: string } }>("/workspaces/:id/receipts/:receiptId", async (req, reply) => {
    const parsed = PatchReceiptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await context(req, app, req.params.id, "editor");
      const receipt = await receiptForWorkspace(req.params.id, req.params.receiptId);
      if (parsed.data.reviewed && (!receipt.verifiedAt || receipt.status !== "ocr_review")) throw new HttpError(409, "receipt_not_ready");
      await prisma.$transaction(async (tx) => {
        const categoryIds = [...new Set((parsed.data.lineItems ?? []).map((item) => item.categoryId).filter((id): id is string => Boolean(id)))];
        if (categoryIds.length) {
          const valid = await tx.category.count({ where: { workspaceId: req.params.id, id: { in: categoryIds } } });
          if (valid !== categoryIds.length) throw new HttpError(400, "category_not_found");
        }
        if (parsed.data.lineItems) {
          const applied = await tx.transactionAllocation.count({ where: { receiptLineItem: { receiptId: receipt.id } } });
          if (applied) throw new HttpError(409, "receipt_already_applied");
          await tx.receiptLineItem.deleteMany({ where: { receiptId: receipt.id } });
          if (parsed.data.lineItems.length) await tx.receiptLineItem.createMany({ data: parsed.data.lineItems.map((item) => ({
            receiptId: receipt.id,
            description: item.description,
            quantity: item.quantity === null || item.quantity === undefined ? null : new Prisma.Decimal(item.quantity),
            unitPrice: item.unitPrice === null || item.unitPrice === undefined ? null : new Prisma.Decimal(item.unitPrice),
            lineTotal: new Prisma.Decimal(item.lineTotal),
            categoryId: item.categoryId ?? null,
            confidence: new Prisma.Decimal(1),
          })) });
        }
        const updateData: Prisma.ReceiptDocumentUpdateInput = {
          ...(parsed.data.role !== undefined ? { role: parsed.data.role } : {}),
          ...(parsed.data.merchantName !== undefined ? { merchantName: parsed.data.merchantName } : {}),
          ...(parsed.data.receiptDate !== undefined ? { receiptDate: parsed.data.receiptDate === null ? null : new Date(parsed.data.receiptDate) } : {}),
          ...(parsed.data.totalAmount !== undefined ? { totalAmount: parsed.data.totalAmount === null ? null : new Prisma.Decimal(parsed.data.totalAmount) } : {}),
          ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency } : {}),
          ...(parsed.data.reviewed ? { status: "reviewed" } : {}),
        };
        await tx.receiptDocument.update({ where: { id: receipt.id }, data: updateData });
      });
      return { receipt: receiptDto(await receiptForWorkspace(req.params.id, receipt.id)) };
    } catch (error) { return mapError(reply, error); }
  });

  app.post<{ Params: { id: string; receiptId: string } }>("/workspaces/:id/receipts/:receiptId/reprocess", async (req, reply) => {
    try {
      await context(req, app, req.params.id, "editor");
      const receipt = await receiptForWorkspace(req.params.id, req.params.receiptId);
      const applied = await prisma.transactionAllocation.count({ where: { receiptLineItem: { receiptId: receipt.id } } });
      if (applied) throw new HttpError(409, "receipt_already_applied");
      if (!receipt.verifiedAt) throw new HttpError(409, "receipt_not_ready");
      if (!["failed", "ocr_review"].includes(receipt.status)) throw new HttpError(409, "receipt_reprocess_not_allowed");
      await prisma.receiptDocument.update({ where: { id: receipt.id }, data: { status: "queued", ocrError: null } });
      await infrastructure.enqueue({ location: receipt.storageRegion as ReceiptStorageLocation, receiptId: receipt.id });
      return reply.code(202).send({ ok: true });
    } catch (error) { return mapError(reply, error); }
  });

  app.post<{ Params: { id: string; receiptId: string } }>("/workspaces/:id/receipts/:receiptId/link", async (req, reply) => {
    const parsed = LinkReceiptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await context(req, app, req.params.id, "editor");
      await receiptForWorkspace(req.params.id, req.params.receiptId);
      const transaction = await prisma.transaction.findFirst({ where: { id: parsed.data.transactionId, workspaceId: req.params.id, removedAt: null, pending: false, budgetImpact: "expense" } });
      if (!transaction) throw new HttpError(404, "transaction_not_found");
      const receipt = await prisma.receiptDocument.update({ where: { id: req.params.receiptId }, data: { transactionId: transaction.id }, include: { lineItems: true } });
      return { receipt: receiptDto(receipt) };
    } catch (error) { return mapError(reply, error); }
  });

  app.post<{ Params: { id: string; receiptId: string } }>("/workspaces/:id/receipts/:receiptId/create-transaction", async (req, reply) => {
    const parsed = CreateTransactionFromReceiptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await context(req, app, req.params.id, "editor");
      const receipt = await receiptForWorkspace(req.params.id, req.params.receiptId);
      if (!receipt.verifiedAt || !["ocr_review", "reviewed"].includes(receipt.status)) throw new HttpError(409, "receipt_not_ready");
      const amount = parsed.data.totalAmount ?? receipt.totalAmount?.toNumber();
      if (!amount) throw new HttpError(400, "receipt_total_required");
      const transaction = await createManualTransactionService(
        { workspaceId: req.params.id, userId: ctx.session.userId },
        {
          merchantRaw: parsed.data.merchant ?? receipt.merchantName ?? "Receipt expense",
          amount,
          accountId: parsed.data.accountId,
          occurredAt: (parsed.data.occurredAt ?? receipt.receiptDate?.toISOString() ?? new Date().toISOString()).slice(0, 10),
        },
      );
      await prisma.receiptDocument.update({ where: { id: receipt.id }, data: { transactionId: transaction.transaction.id } });
      return reply.code(201).send(transaction);
    } catch (error) { return mapError(reply, error); }
  });

  app.post<{ Params: { id: string; receiptId: string } }>("/workspaces/:id/receipts/:receiptId/apply", async (req, reply) => {
    const parsed = ApplyReceiptBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      await context(req, app, req.params.id, "editor");
      const result = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${req.params.id}))`;
        const receipt = await tx.receiptDocument.findFirst({
          where: { id: req.params.receiptId, workspaceId: req.params.id, deletedAt: null, verifiedAt: { not: null }, status: { in: ["ocr_review", "reviewed"] } },
          include: { lineItems: { orderBy: [{ page: "asc" }, { createdAt: "asc" }] } },
        });
        if (!receipt) throw new HttpError(409, "receipt_not_ready");
        if (parsed.data.mode === "items" && receipt.role === "payment_proof") throw new HttpError(400, "itemized_receipt_required");
        const transaction = await tx.transaction.findFirst({ where: { id: parsed.data.transactionId, workspaceId: req.params.id, removedAt: null, pending: false, budgetImpact: "expense" } });
        if (!transaction) throw new HttpError(404, "transaction_not_found");
        if (transaction.version !== parsed.data.expectedTransactionVersion) throw new HttpError(409, "transaction_changed", undefined, { currentVersion: transaction.version });
        const sign = transaction.amount.isNegative() ? -1 : 1;
        if (parsed.data.mode === "whole") {
          const full = transaction.amount.abs().toNumber();
          await applyAllocations(tx, req.params.id, transaction.id, transaction.amount, "manual", [{
            categoryId: parsed.data.categoryId,
            amount: sign * full,
            businessAmount: parsed.data.businessAmount ?? full,
          }]);
        } else {
          const requested = new Map(parsed.data.items.map((item) => [item.lineItemId, item]));
          if (requested.size !== parsed.data.items.length || [...requested.keys()].some((id) => !receipt.lineItems.some((line) => line.id === id))) {
            throw new HttpError(400, "receipt_line_item_not_found");
          }
          const txCents = Math.round(transaction.amount.abs().toNumber() * 100);
          const cents = proportionalCents(receipt.lineItems, txCents);
          const allocations = receipt.lineItems.flatMap((line) => {
            const allocatedCents = cents.get(line.id) ?? 0;
            if (!allocatedCents) return [];
            const selected = requested.get(line.id);
            const allocated = allocatedCents / 100;
            if (selected && selected.businessAmount > allocated) throw new HttpError(400, "invalid_business_amount");
            return [{
              categoryId: selected?.categoryId ?? line.categoryId,
              amount: sign * allocated,
              businessAmount: selected?.businessAmount ?? 0,
              receiptLineItemId: line.id,
            }];
          });
          await applyAllocations(tx, req.params.id, transaction.id, transaction.amount, "manual", allocations);
        }
        const updated = await tx.transaction.update({
          where: { id: transaction.id },
          data: receipt.role === "payment_proof" ? {} : { classificationSourceReceiptId: receipt.id },
          select: { id: true, version: true },
        });
        await tx.receiptDocument.update({ where: { id: receipt.id }, data: { transactionId: transaction.id, status: "reviewed" } });
        return updated;
      });
      return { transaction: result, evidenceLabel: "Evidence complete status is calculated from all linked evidence" };
    } catch (error) { return mapError(reply, error); }
  });

  app.delete<{ Params: { id: string; receiptId: string } }>("/workspaces/:id/receipts/:receiptId", async (req, reply) => {
    try {
      const ctx = await context(req, app, req.params.id, "owner");
      const receipt = await receiptForWorkspace(req.params.id, req.params.receiptId);
      const now = new Date();
      await infrastructure.deleteObject({
        location: receipt.storageRegion as ReceiptStorageLocation,
        bucket: receipt.storageBucket,
        key: receipt.storageKey,
      });
      await prisma.$transaction(async (tx) => {
        await tx.transaction.updateMany({ where: { classificationSourceReceiptId: receipt.id }, data: { classificationSourceReceiptId: null, version: { increment: 1 } } });
        await tx.receiptDocument.update({ where: { id: receipt.id }, data: { status: "deleted", deletedAt: now, transactionId: null } });
      });
      await logAuditEvent({
        workspaceId: req.params.id,
        actorType: "user",
        actorUserId: ctx.session.userId,
        action: "delete_receipt",
        targetType: "receipt",
        targetId: receipt.id,
        payload: { sha256: receipt.sha256, originalName: receipt.originalName, mimeType: receipt.mimeType, byteSize: receipt.byteSize },
      });
      return reply.code(204).send();
    } catch (error) { return mapError(reply, error); }
  });
}
