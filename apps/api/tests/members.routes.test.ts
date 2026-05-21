import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
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

describe("members routes", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("GET /workspaces/:id/members — owner sees self", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/members`,
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0]).toMatchObject({ email: "o@x.com", role: "owner" });
    await app.close();
  });

  it("GET /workspaces/:id/members — 404 when caller not member", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O2" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${otherWs.id}/members`,
      headers: { cookie: u.cookie, "x-workspace-id": otherWs.id },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("PATCH /workspaces/:id/members/:userId — owner promotes viewer to editor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m@x.com", name: "M" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/members/${member.userId}`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ role: "editor" }),
    });
    expect(res.statusCode).toBe(200);
    const m = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: member.userId, workspaceId: wsId } },
    });
    expect(m.role).toBe("editor");
    await app.close();
  });

  it("PATCH — 403 when caller is not owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m4@x.com", name: "M4" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/members/${owner.userId}`,
      headers: {
        cookie: member.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ role: "viewer" }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("PATCH role=owner triggers transfer — current owner becomes editor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O5" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m5@x.com", name: "M5" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "PATCH",
      url: `/workspaces/${wsId}/members/${member.userId}`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ role: "owner" }),
    });
    expect(res.statusCode).toBe(200);
    const o = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: owner.userId, workspaceId: wsId } },
    });
    const n = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: member.userId, workspaceId: wsId } },
    });
    expect(o.role).toBe("editor");
    expect(n.role).toBe("owner");
    await app.close();
  });

  it("DELETE — owner removes a member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O6" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m6@x.com", name: "M6" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/members/${member.userId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    const m = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: member.userId, workspaceId: wsId } },
    });
    expect(m).toBeNull();
    await app.close();
  });

  it("DELETE — member can leave (delete self) when not last owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7@x.com", name: "O7" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m7@x.com", name: "M7" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "viewer" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/members/${member.userId}`,
      headers: { cookie: member.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it("DELETE — 403 when non-owner tries to remove someone else", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o8@x.com", name: "O8" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const a = await signUpAndGetCookie(app, { email: "a8@x.com", name: "A8" });
    const b = await signUpAndGetCookie(app, { email: "b8@x.com", name: "B8" });
    await prisma.membership.create({
      data: { userId: a.userId, workspaceId: wsId, role: "editor" },
    });
    await prisma.membership.create({
      data: { userId: b.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/members/${b.userId}`,
      headers: { cookie: a.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("DELETE — 409 last owner cannot leave", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o9@x.com", name: "O9" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/members/${owner.userId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("last_owner");
    await app.close();
  });
});
