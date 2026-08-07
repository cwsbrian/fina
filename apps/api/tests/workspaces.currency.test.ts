import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setupOwner(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

describe("PATCH /workspaces/:id/currency", () => {
  it("200 happy: fresh workspace + valid ISO updates currency", async () => {
    const { cookie, wsId } = await setupOwner("pc1@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workspace: { currency: string } };
    expect(body.workspace.currency).toBe("USD");
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: wsId } });
    expect(ws.currency).toBe("USD");
    const accounts = await prisma.bankAccount.findMany({
      where: { workspaceId: wsId },
      select: { currency: true },
    });
    expect(accounts.every((a) => a.currency === "USD")).toBe(true);

    const budget = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/budget-plans/current`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(budget.statusCode).toBe(200);
    expect(budget.json().currency).toBe("USD");
  });

  it("400 invalid_body: lowercase currency", async () => {
    const { cookie, wsId } = await setupOwner("pc2@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "us" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("400 invalid_body: too-long currency", async () => {
    const { cookie, wsId } = await setupOwner("pc3@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "DOLLAR" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body" });
  });

  it("403 insufficient_role: editor cannot change currency", async () => {
    const owner = await setupOwner("pc4own@t.co");
    const editor = await setupOwner("pc4ed@t.co");
    await prisma.membership.create({
      data: { userId: editor.userId, workspaceId: owner.wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${owner.wsId}/currency`,
      headers: { cookie: editor.cookie, "x-workspace-id": owner.wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "insufficient_role" });
  });

  it("200 relabels existing bank accounts", async () => {
    const { cookie, wsId } = await setupOwner("pc5@t.co");
    await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Acct", type: "depository", currency: "CAD" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(200);
    const accounts = await prisma.bankAccount.findMany({ where: { workspaceId: wsId } });
    expect(accounts.every((account) => account.currency === "USD")).toBe(true);
  });

  it("200 keeps existing transaction numbers unchanged while relabeling", async () => {
    const { cookie, wsId } = await setupOwner("pc6@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Cash", type: "depository", currency: "CAD" },
    });
    const transaction = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        amount: "1.00", merchantRaw: "x", occurredAt: new Date("2026-05-18T12:00:00Z"),
        source: "manual", rawData: {},
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(200);
    const saved = await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } });
    expect(saved.amount.toString()).toBe("1");
    expect((await prisma.bankAccount.findUniqueOrThrow({ where: { id: acct.id } })).currency).toBe("USD");
  });

  it("200 keeps recurring amounts unchanged", async () => {
    const { cookie, wsId } = await setupOwner("pc7@t.co");
    await prisma.recurringExpense.create({
      data: {
        workspaceId: wsId, name: "Netflix", nameNormalized: "netflix",
        amount: "19.99", cadence: "monthly",
        nextOccurrenceDate: new Date("2026-08-01T12:00:00Z"),
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(200);
    const recurring = await prisma.recurringExpense.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(recurring.amount.toString()).toBe("19.99");
  });

  it("200 keeps budget amounts unchanged", async () => {
    const { cookie, wsId } = await setupOwner("pc8@t.co");
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Coffee" },
    });
    await prisma.budgetPlan.create({
      data: {
        workspaceId: wsId,
        totalAmount: "100.00",
        categoryAllocations: [{ categoryId: cat.id, amount: 100 }],
        periodStart: new Date("2026-05-01"),
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/currency`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: { currency: "USD" },
    });
    expect(res.statusCode).toBe(200);
    const plan = await prisma.budgetPlan.findFirstOrThrow({ where: { workspaceId: wsId } });
    expect(plan.totalAmount.toString()).toBe("100");
  });
});
