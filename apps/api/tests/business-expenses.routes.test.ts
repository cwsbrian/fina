import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();
let app: FastifyInstance;
let counter = 0;

beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function owner() {
  const auth = await signUpAndGetCookie(app, { email: `business-${counter++}@t.co`, name: "Owner" });
  const workspaceId = await getOwnerWorkspaceId(auth.userId);
  return { ...auth, workspaceId };
}

async function convert(cookie: string, workspaceId: string) {
  return await app.inject({
    method: "PATCH",
    url: `/workspaces/${workspaceId}/kind`,
    headers: { cookie, "x-workspace-id": workspaceId },
    payload: { kind: "business", taxCountry: "CA" },
  });
}

describe("business workspaces", () => {
  it("creates a business workspace with a required country and business categories", async () => {
    const user = await owner();
    const response = await app.inject({
      method: "POST",
      url: "/workspaces",
      headers: { cookie: user.cookie },
      payload: { name: "Studio", currency: "USD", kind: "business", taxCountry: "US" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().workspace).toMatchObject({ kind: "business", taxCountry: "US", currency: "USD" });
    const workspaceId = response.json().workspace.id as string;
    expect(await prisma.category.count({ where: { workspaceId, name: "Software" } })).toBe(1);
  });

  it("blocks business APIs from personal workspaces and personal feature writes from business", async () => {
    const user = await owner();
    const personal = await app.inject({
      method: "GET",
      url: `/workspaces/${user.workspaceId}/business/overview?yearMonth=2026-08`,
      headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId },
    });
    expect(personal.statusCode).toBe(403);
    expect((await convert(user.cookie, user.workspaceId)).statusCode).toBe(200);
    const goal = await app.inject({
      method: "POST",
      url: `/workspaces/${user.workspaceId}/goals`,
      headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId },
      payload: {},
    });
    expect(goal.statusCode).toBe(403);
    expect(goal.json().error).toBe("personal_workspace_required");
  });

  it("stores partial business use and rejects a stale expectedVersion", async () => {
    const user = await owner();
    await convert(user.cookie, user.workspaceId);
    const account = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: user.workspaceId } });
    const category = await prisma.category.findFirstOrThrow({ where: { workspaceId: user.workspaceId, type: "expense" } });
    const transaction = await prisma.transaction.create({
      data: {
        workspaceId: user.workspaceId,
        accountId: account.id,
        amount: "100.00",
        merchantRaw: "Mixed purchase",
        occurredAt: new Date("2026-08-12T12:00:00Z"),
        source: "manual",
        rawData: {},
        allocations: { create: { amount: "100.00", categoryId: category.id, businessAmount: null } },
      },
    });
    const allocation = await prisma.transactionAllocation.findFirstOrThrow({ where: { transactionId: transaction.id } });
    const response = await app.inject({
      method: "PUT",
      url: `/workspaces/${user.workspaceId}/transactions/${transaction.id}/business-use`,
      headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId },
      payload: { expectedVersion: 1, allocations: [{ allocationId: allocation.id, categoryId: category.id, amount: 100, businessAmount: 35 }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().transaction).toMatchObject({ version: 2, allocations: [{ businessAmount: "35.00" }] });

    const stale = await app.inject({
      method: "PUT",
      url: `/workspaces/${user.workspaceId}/transactions/${transaction.id}/business-use`,
      headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId },
      payload: { expectedVersion: 1, allocations: [{ allocationId: allocation.id, categoryId: category.id, amount: 100, businessAmount: 100 }] },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("transaction_changed");
  });

  it("fails closed when private receipt infrastructure is not configured", async () => {
    const user = await owner();
    await convert(user.cookie, user.workspaceId);
    const response = await app.inject({
      method: "POST",
      url: `/workspaces/${user.workspaceId}/receipts/upload-intents`,
      headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId },
      payload: { originalName: "receipt.jpg", mimeType: "image/jpeg", byteSize: 100, role: "combined" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("receipt_storage_unavailable");
    expect(await prisma.receiptDocument.count({ where: { workspaceId: user.workspaceId } })).toBe(0);
  });

  it("rejects applying an upload that has not been verified and OCR-reviewed", async () => {
    const user = await owner();
    await convert(user.cookie, user.workspaceId);
    const account = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: user.workspaceId } });
    const category = await prisma.category.findFirstOrThrow({ where: { workspaceId: user.workspaceId, type: "expense" } });
    const transaction = await prisma.transaction.create({ data: {
      workspaceId: user.workspaceId, accountId: account.id, amount: "20.00", merchantRaw: "Unverified",
      occurredAt: new Date(), source: "manual", rawData: {}, allocations: { create: { amount: "20.00", categoryId: category.id } },
    } });
    const receipt = await prisma.receiptDocument.create({ data: {
      workspaceId: user.workspaceId, transactionId: transaction.id, role: "combined", status: "uploading",
      originalName: "fake.jpg", mimeType: "image/jpeg", byteSize: 10, storageRegion: "enam",
      storageBucket: "private", storageKey: `fake/${transaction.id}`, uploadedById: user.userId,
    } });
    const response = await app.inject({
      method: "POST", url: `/workspaces/${user.workspaceId}/receipts/${receipt.id}/apply`,
      headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId },
      payload: { mode: "whole", transactionId: transaction.id, expectedTransactionVersion: 1, categoryId: category.id },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("receipt_not_ready");
  });

  it("counts confirmed and unreviewed portions of the same split independently", async () => {
    const user = await owner();
    await convert(user.cookie, user.workspaceId);
    const account = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: user.workspaceId } });
    const category = await prisma.category.findFirstOrThrow({ where: { workspaceId: user.workspaceId, type: "expense" } });
    await prisma.transaction.create({ data: {
      workspaceId: user.workspaceId, accountId: account.id, amount: "100.00", merchantRaw: "Mixed split",
      occurredAt: new Date("2026-08-15T00:00:00Z"), source: "manual", rawData: {}, allocations: { create: [
        { amount: "60.00", categoryId: category.id, businessAmount: "30.00" },
        { amount: "40.00", categoryId: category.id, businessAmount: null },
      ] },
    } });
    const overview = await app.inject({ method: "GET", url: `/workspaces/${user.workspaceId}/business/overview?yearMonth=2026-08`, headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().overview).toMatchObject({ confirmedBusinessExpenses: "30.00", expenseReviewAmount: "40.00", expenseReviewCount: 1 });
    const business = await app.inject({ method: "GET", url: `/workspaces/${user.workspaceId}/business/expenses?yearMonth=2026-08&view=business`, headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId } });
    const review = await app.inject({ method: "GET", url: `/workspaces/${user.workspaceId}/business/expenses?yearMonth=2026-08&view=review`, headers: { cookie: user.cookie, "x-workspace-id": user.workspaceId } });
    expect(business.json().expenses).toHaveLength(1);
    expect(review.json().expenses).toHaveLength(1);
  });
});
