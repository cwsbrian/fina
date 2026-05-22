import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { resetPlaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { resetGeminiMock } from "./helpers/gemini-mock.js";
const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

beforeEach(async () => {
  await truncateAll();
  resetPlaidMock();
  resetGeminiMock();
});

afterAll(async () => {
  await disconnect();
});

describe("GET /workspaces/:id/categories", () => {
  it("seeded user has 11 default categories", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "cat-list@x.com", name: "CL" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const names = (res.json().categories as Array<{ name: string }>).map((c) => c.name).sort();
    expect(names).toEqual([
      "Dining", "Entertainment", "Groceries", "Health", "Housing",
      "Income", "Other", "Shopping", "Subscriptions", "Transit", "Utilities",
    ]);
    await app.close();
  });

  it("404 for non-member workspace", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "cat-nm@x.com", name: "NM" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/categories`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /workspaces/:id/categories", () => {
  it("owner creates new category", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-mk@x.com", name: "Mk" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Hobbies" }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().category.name).toBe("Hobbies");
    await app.close();
  });

  it("editor cannot create — 403", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-ed-o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const editor = await signUpAndGetCookie(app, { email: "cat-ed-e@x.com", name: "E" });
    await prisma.membership.create({
      data: { userId: editor.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: editor.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Hobbies" }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("duplicate name (exact case) — 422", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-dup@x.com", name: "D" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Groceries" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("duplicate_name");
    await app.close();
  });

  it("duplicate name (case-insensitive) — 422", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-dup-ci@x.com", name: "DC" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "groceries" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("duplicate_name");
    await app.close();
  });

  it("name length 41 → 400 invalid_body", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-long@x.com", name: "L" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "X".repeat(41) }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
    await app.close();
  });

  it("30 active categories cap — 422 on the 31st", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-cap@x.com", name: "C" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    // Seeded 11 + we add 19 more = 30
    for (let i = 0; i < 19; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/categories`,
        headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
        payload: JSON.stringify({ name: `Cat${i}` }),
      });
      expect(r.statusCode).toBe(201);
    }
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "CatTooMany" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("too_many_categories");
    await app.close();
  });

  it("workspace_mismatch — 400", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-wm@x.com", name: "WM" });
    const wsA = await getOwnerWorkspaceId(owner.userId);
    const wsB = (await prisma.workspace.create({ data: { name: "Other" } })).id;
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsA, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Hobbies" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});

describe("PATCH /workspaces/:id/categories/:catId", () => {
  it("owner renames category", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-ren@x.com", name: "R" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const cat = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Other" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/categories/${cat.id}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Misc" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().category.name).toBe("Misc");
    await app.close();
  });

  it("rename to existing active name → 422", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-ren-dup@x.com", name: "RD" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const other = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Other" } });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/categories/${other.id}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "Groceries" }),
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });

  it("archive then create same-name (different case) → success", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "cat-archrec@x.com", name: "AR" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const groc = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Groceries" } });
    // Archive
    const arc = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/categories/${groc.id}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ archived: true }),
    });
    expect(arc.statusCode).toBe(200);
    // Recreate with different case
    const rec = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/categories`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ name: "groceries" }),
    });
    expect(rec.statusCode).toBe(201);
    await app.close();
  });
});

describe("POST /workspaces/:id/transactions/:txId/categorize", () => {
  async function setupTx(wsIdEmail: string): Promise<{ wsId: string; cookie: string; txId: string; loblawsTxId: string }> {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: wsIdEmail, name: "U" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Checking", type: "depository" },
    });
    const tx1 = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: `pt_${Date.now()}`,
        amount: 5, merchantRaw: "Starbucks", occurredAt: new Date("2026-05-10"), rawData: {},
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx1.id, categoryId: null, amount: "5", source: null },
    });
    // A sibling Starbucks tx (uncategorized) to verify back-fill
    const tx2 = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: `pt2_${Date.now()}`,
        amount: 6, merchantRaw: "Starbucks", occurredAt: new Date("2026-05-09"), rawData: {},
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: tx2.id, categoryId: null, amount: "6", source: null },
    });
    await app.close();
    return { wsId, cookie: u.cookie, txId: tx1.id, loblawsTxId: tx2.id };
  }

  it("happy path — tx updated, mapping created, siblings back-filled", async () => {
    const { wsId, cookie, txId, loblawsTxId: siblingId } = await setupTx("manual-cat@x.com");
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transaction.allocations[0].source).toBe("manual");
    expect(body.backfilledCount).toBe(1);

    // Sibling should now have allocation source='mapping'
    const siblingAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: siblingId } });
    expect(siblingAlloc?.source).toBe("mapping");
    // Mapping row exists
    const m = await prisma.merchantMapping.findFirstOrThrow({
      where: { workspaceId: wsId, merchantNormalized: "starbucks" },
    });
    expect(m.source).toBe("manual");
    await app.close();
  });

  it("viewer caller — 403", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "mc-o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const viewer = await signUpAndGetCookie(app, { email: "mc-v@x.com", name: "V" });
    await prisma.membership.create({ data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" } });
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "Checking", type: "depository" },
    });
    const t = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acct.id, plaidTransactionId: `vc${Date.now()}`, amount: 1, merchantRaw: "X", occurredAt: new Date(), rawData: {} },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${t.id}/categorize`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("category doesn't exist — 404", async () => {
    const { wsId, cookie, txId } = await setupTx("mc-404@x.com");
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "NonExistent" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("category_not_found");
    await app.close();
  });

  it("category archived — 404 (active-only resolution)", async () => {
    const { wsId, cookie, txId } = await setupTx("mc-arc@x.com");
    const app = await buildApp(env);
    await prisma.category.updateMany({
      where: { workspaceId: wsId, name: "Dining" },
      data: { archivedAt: new Date() },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("back-fill skips manual-source siblings", async () => {
    const { wsId, cookie, txId, loblawsTxId: siblingId } = await setupTx("mc-skip-manual@x.com");
    // Pre-set sibling as manual (allocation only — tx columns dropped in Task 8).
    const groceriesCat = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Groceries" } });
    await prisma.transaction.update({
      where: { id: siblingId },
      data: { merchantNormalized: "starbucks" },
    });
    await prisma.transactionAllocation.updateMany({
      where: { transactionId: siblingId },
      data: { categoryId: groceriesCat.id, source: "manual" },
    });

    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(200);

    // Sibling should KEEP its manual Groceries
    const siblingAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: siblingId } });
    expect(siblingAlloc?.categoryId).toBe(groceriesCat.id);
    expect(siblingAlloc?.source).toBe("manual");
    await app.close();
  });

  it("back-fill normalizes NULL-merchantNormalized siblings before applying", async () => {
    const { wsId, cookie, txId } = await setupTx("mc-null-mn@x.com");
    const acct = await prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: wsId } });
    // Create a legacy sibling with NULL merchantNormalized
    const legacy = await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id,
        plaidTransactionId: `legacy_${Date.now()}`,
        amount: 7, merchantRaw: "Starbucks", occurredAt: new Date("2026-05-08"), rawData: {},
        // merchantNormalized intentionally left NULL
      },
    });
    await prisma.transactionAllocation.create({
      data: { transactionId: legacy.id, categoryId: null, amount: "7", source: null },
    });
    expect(legacy.merchantNormalized).toBeNull();

    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(200);

    const after = await prisma.transaction.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(after.merchantNormalized).toBe("starbucks");   // normalized
    const afterAlloc = await prisma.transactionAllocation.findFirst({ where: { transactionId: legacy.id } });
    expect(afterAlloc?.source).toBe("mapping");   // back-filled
    await app.close();
  });

  it("workspace_mismatch — 400", async () => {
    const { wsId, cookie, txId } = await setupTx("mc-wm@x.com");
    const wsB = (await prisma.workspace.create({ data: { name: "B" } })).id;
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsB}/transactions/${txId}/categorize`,
      headers: { cookie, "x-workspace-id": wsId, "content-type": "application/json" },
      payload: JSON.stringify({ categoryName: "Dining" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
    await app.close();
  });
});
