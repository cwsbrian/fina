import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setupEditor(email: string): Promise<{ cookie: string; wsId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId };
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

async function seedPlaid(wsId: string, opts: { pending: boolean; removed?: boolean }): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Plaid", type: "depository" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId, accountId: acct.id,
      plaidTransactionId: `p_${Math.random()}`,
      amount: "5", merchantRaw: "Plaid Co", merchantNormalized: "plaid co",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: opts.pending, source: "plaid", rawData: {},
      removedAt: opts.removed ? new Date() : null,
    },
  });
  return tx.id;
}

describe("DELETE /workspaces/:id/transactions/:txId", () => {
  it("200 removed=true on first call (manual)", async () => {
    const { cookie, wsId } = await setupEditor("d1@t.co");
    const txId = await seedManual(cookie, wsId);
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
  });

  it("200 removed=true (plaid posted)", async () => {
    const { cookie, wsId } = await setupEditor("d2@t.co");
    const txId = await seedPlaid(wsId, { pending: false });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true });
  });

  it("400 cannot_delete_pending (plaid pending)", async () => {
    const { cookie, wsId } = await setupEditor("d3@t.co");
    const txId = await seedPlaid(wsId, { pending: true });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cannot_delete_pending");
  });

  it("200 idempotent on second call", async () => {
    const { cookie, wsId } = await setupEditor("d4@t.co");
    const txId = await seedManual(cookie, wsId);
    await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: false, alreadyRemoved: true });
  });

  it("400 workspace_mismatch", async () => {
    const { cookie, wsId } = await setupEditor("d5@t.co");
    const txId = await seedManual(cookie, wsId);
    const other = await prisma.workspace.create({ data: { name: "o" } });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${other.id}/transactions/${txId}`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("workspace_mismatch");
  });

  it("401 without session", async () => {
    const { wsId } = await setupEditor("d6@t.co");
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/anything`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("404 not_found", async () => {
    const { cookie, wsId } = await setupEditor("d7@t.co");
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/no-such`,
      headers: { cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
  });

  it("403 insufficient_role: viewer cannot DELETE", async () => {
    const editor = await signUpAndGetCookie(app, { email: "d8-editor@t.co" });
    const wsId = await getOwnerWorkspaceId(editor.userId);
    const txId = await seedManual(editor.cookie, wsId);

    const viewer = await signUpAndGetCookie(app, { email: "d8-viewer@t.co" });
    await prisma.membership.create({
      data: { userId: viewer.userId, workspaceId: wsId, role: "viewer" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/transactions/${txId}`,
      headers: { cookie: viewer.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("insufficient_role");
  });
});
