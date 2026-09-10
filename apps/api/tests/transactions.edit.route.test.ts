import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setupEditor(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

async function seedManual(cookie: string, wsId: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${wsId}/transactions/manual`,
    headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
    payload: JSON.stringify({ merchantRaw: "Costco", amount: 10, occurredAt: "2026-05-19" }),
  });
  return res.json().transaction.id;
}

describe("PATCH /workspaces/:id/transactions/:txId", () => {
  it("happy: 200 with full body returns updated tx", async () => {
    const { cookie, wsId } = await setupEditor("ep1@t.co");
    const txId = await seedManual(cookie, wsId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries-ep1" } });

    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({
        amount: 12.5, merchantRaw: "Walmart", occurredAt: "2026-05-18",
        categoryId: cat.id, note: "weekly",
      }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transaction.amount).toBe("12.5");
    expect(body.transaction.merchantRaw).toBe("Walmart");
    expect(body.transaction.merchantNormalized).toBe("walmart");
    expect(body.transaction.allocations[0].categoryId).toBe(cat.id);
  });

  it("200 empty body returns current tx unchanged", async () => {
    const { cookie, wsId } = await setupEditor("ep2@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: "{}",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.id).toBe(txId);
  });

  it("supports one-time and future merchant budget exclusions", async () => {
    const { cookie, wsId } = await setupEditor("ep-budget-scope@t.co");
    const headers = { cookie, "x-workspace-id": wsId, "content-type": "application/json" };
    const firstId = await seedManual(cookie, wsId);

    const once = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${firstId}`,
      headers,
      payload: JSON.stringify({ budgetImpact: "excluded", budgetImpactScope: "transaction" }),
    });
    expect(once.statusCode).toBe(200);
    expect(once.json().transaction.merchantExclusionActive).toBe(false);
    expect(await prisma.merchantExclusion.count({ where: { workspaceId: wsId } })).toBe(0);

    const always = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${firstId}`,
      headers,
      payload: JSON.stringify({ budgetImpact: "excluded", budgetImpactScope: "merchant" }),
    });
    expect(always.statusCode).toBe(200);
    expect(always.json().transaction.merchantExclusionActive).toBe(true);

    const future = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/manual`,
      headers,
      payload: JSON.stringify({ merchantRaw: "Costco #123", amount: 20, occurredAt: "2026-05-20" }),
    });
    expect(future.json().transaction).toMatchObject({
      budgetImpact: "excluded",
      budgetImpactSource: "user",
      merchantExclusionActive: true,
    });

    const detail = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/transactions/${firstId}`,
      headers,
    });
    expect(detail.json().transaction.merchantExclusionActive).toBe(true);

    const includeOnce = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${firstId}`,
      headers,
      payload: JSON.stringify({ budgetImpact: "expense", budgetImpactScope: "transaction" }),
    });
    expect(includeOnce.json().transaction.merchantExclusionActive).toBe(true);

    const excludeOnce = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${firstId}`,
      headers,
      payload: JSON.stringify({ budgetImpact: "excluded", budgetImpactScope: "transaction" }),
    });
    expect(excludeOnce.json().transaction).toMatchObject({
      budgetImpact: "excluded",
      merchantExclusionActive: false,
    });
  });

  it("400 invalid_body: amount not a number", async () => {
    const { cookie, wsId } = await setupEditor("ep3@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: "abc" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 invalid_body: amount null (non-nullable field)", async () => {
    const { cookie, wsId } = await setupEditor("ep4@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: null }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 invalid_body: merchantRaw null", async () => {
    const { cookie, wsId } = await setupEditor("ep4b@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ merchantRaw: null }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 invalid_body: unknown key (.strict())", async () => {
    const { cookie, wsId } = await setupEditor("ep5@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ merchant: "typo" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  });

  it("400 not_editable for plaid tx", async () => {
    const { cookie, wsId } = await setupEditor("ep6@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid", type: "depository" },
    });
    const ptx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_xyz",
        amount: "5", merchantRaw: "Plaid Co", merchantNormalized: "plaid co",
        occurredAt: new Date("2026-05-19T12:00:00Z"),
        pending: false, source: "plaid", rawData: {},
      },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${ptx.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_editable");
  });

  it("400 already_removed", async () => {
    const { cookie, wsId } = await setupEditor("ep7@t.co");
    const txId = await seedManual(cookie, wsId);
    await prisma.transaction.update({ where: { id: txId }, data: { removedAt: new Date() } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("already_removed");
  });

  it("400 workspace_mismatch", async () => {
    const { cookie, wsId } = await setupEditor("ep8@t.co");
    const txId = await seedManual(cookie, wsId);
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${other.id}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
  });

  it("404 not_found", async () => {
    const { cookie, wsId } = await setupEditor("ep9@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/no-such-tx`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("404 category_not_found", async () => {
    const { cookie, wsId } = await setupEditor("ep10@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId: "no-such-cat" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("category_not_found");
  });

  it("401 without session", async () => {
    const { wsId } = await setupEditor("ep11@t.co");
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/anything`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("403 insufficient_role: viewer cannot PATCH", async () => {
    const editor = await signUpAndGetCookie(app, { email: "ep12-editor@t.co" });
    const wsId = await getOwnerWorkspaceId(editor.userId);
    const txId = await seedManual(editor.cookie, wsId);

    const viewer = await signUpAndGetCookie(app, { email: "ep12-viewer@t.co" });
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ amount: 1 }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });

  // ── NEW TESTS (Task 5) ──────────────────────────────────────────────────────

  it("PATCH with allocations array → 200, response.allocations matches", async () => {
    const { cookie, wsId } = await setupEditor("ep-alloc@t.co");
    const txId = await seedManual(cookie, wsId);
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-ep-alloc" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-ep-alloc" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({
        allocations: [
          { categoryId: c1.id, amount: 4 },
          { categoryId: c2.id, amount: 6 },
        ],
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.allocations).toHaveLength(2);
  });

  it("PATCH categoryId shortcut → response has 1 allocation", async () => {
    const { cookie, wsId } = await setupEditor("ep-shortcut@t.co");
    const txId = await seedManual(cookie, wsId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C-ep-shortcut" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId: cat.id }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.allocations).toHaveLength(1);
    expect(res.json().transaction.allocations[0].categoryId).toBe(cat.id);
  });

  it("PATCH both categoryId and allocations → 400 conflicting_body", async () => {
    const { cookie, wsId } = await setupEditor("ep-conflict@t.co");
    const txId = await seedManual(cookie, wsId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C-ep-conf" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({
        categoryId: cat.id,
        allocations: [{ categoryId: cat.id, amount: 10 }],
      }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("conflicting_body");
  });

  it("PATCH allocations sum mismatch → 400 sum_mismatch", async () => {
    const { cookie, wsId } = await setupEditor("ep-sum@t.co");
    const txId = await seedManual(cookie, wsId);
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C-ep-sum" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ allocations: [{ categoryId: cat.id, amount: 5 }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("sum_mismatch");
  });

  it("PATCH allocations on pending Plaid → 400 cannot_split_pending", async () => {
    const { cookie, wsId } = await setupEditor("ep-pending@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid", type: "depository" },
    });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_ep_pending",
        amount: "10", merchantRaw: "X", merchantNormalized: "x",
        occurredAt: new Date(), pending: true, source: "plaid", rawData: {},
      },
    });
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "C-ep-pending" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${tx.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ allocations: [{ categoryId: cat.id, amount: 10 }] }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_split_pending");
  });

  it("PATCH categoryId on pending Plaid applies selected and same-merchant review rows immediately", async () => {
    const { cookie, wsId } = await setupEditor("ep-pending-cat@t.co");
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Plaid", type: "depository" },
    });
    const oldCat = await prisma.category.create({ data: { workspaceId: wsId, name: "Old Review Cat" } });
    const newCat = await prisma.category.create({ data: { workspaceId: wsId, name: "New Review Cat" } });
    const selected = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_ep_pending_cat",
        amount: "10", merchantRaw: "APPLE.COM/BILL", merchantNormalized: "apple",
        occurredAt: new Date(), pending: true, source: "plaid", rawData: {},
        allocations: { create: { amount: "10", categoryId: oldCat.id, source: "ai", needsConfirmation: true } },
      },
    });
    const sibling = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_ep_pending_cat_sibling",
        amount: "6", merchantRaw: "Apple Services", merchantNormalized: "apple",
        occurredAt: new Date(), pending: true, source: "plaid", rawData: {},
        allocations: { create: { amount: "6", categoryId: oldCat.id, source: "ai", needsConfirmation: true } },
      },
    });
    const otherMerchant = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "p_ep_pending_cat_other",
        amount: "7", merchantRaw: "Netflix", merchantNormalized: "netflix",
        occurredAt: new Date(), pending: true, source: "plaid", rawData: {},
        allocations: { create: { amount: "7", categoryId: oldCat.id, source: "ai", needsConfirmation: true } },
      },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${selected.id}`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryId: newCat.id }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().transaction.allocations[0].categoryId).toBe(newCat.id);
    expect(res.json().affectedTransactionIds.sort()).toEqual([selected.id, sibling.id].sort());

    const siblingAlloc = await prisma.transactionAllocation.findFirstOrThrow({
      where: { transactionId: sibling.id },
    });
    expect(siblingAlloc.categoryId).toBe(newCat.id);
    expect(siblingAlloc.source).toBe("manual");
    expect(siblingAlloc.needsConfirmation).toBe(false);

    const otherAlloc = await prisma.transactionAllocation.findFirstOrThrow({
      where: { transactionId: otherMerchant.id },
    });
    expect(otherAlloc.categoryId).toBe(oldCat.id);

    const mapping = await prisma.merchantMapping.findUniqueOrThrow({
      where: { workspaceId_merchantNormalized: { workspaceId: wsId, merchantNormalized: "apple" } },
    });
    expect(mapping.categoryId).toBe(newCat.id);
    expect(mapping.source).toBe("manual");
  });

  it("PATCH with no body returns 200 (empty input)", async () => {
    const { cookie, wsId } = await setupEditor("ep-nobody@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
      // intentionally no payload and no content-type
    });
    expect(res.statusCode).toBe(200);
  });
});
