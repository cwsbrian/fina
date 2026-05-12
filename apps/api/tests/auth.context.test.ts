import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import { requireWorkspaceContext } from "../src/auth/context.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

// We exercise requireWorkspaceContext through a temporary route mounted in the test.
// The helper is route-agnostic so this is the right surface to verify.
async function mountProbe(app: FastifyInstance): Promise<void> {
  app.get("/_probe/ws", async (req, reply) => {
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "viewer" });
      return { ok: true, workspaceId: ctx.membership.workspaceId, role: ctx.membership.role };
    } catch (e) {
      const err = e as { statusCode?: number; code?: string; message?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.code ?? "internal", message: err.message });
    }
  });
}

describe("requireWorkspaceContext", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("401 when no session", async () => {
    const app = await buildApp(env);
    await mountProbe(app);
    const res = await app.inject({
      method: "GET",
      url: "/_probe/ws",
      headers: { "x-workspace-id": "ws_anything" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("400 when X-Workspace-Id header missing", async () => {
    const app = await buildApp(env);
    await mountProbe(app);
    const u = await signUpAndGetCookie(app, { email: "ctx1@x.com", name: "C1" });
    const res = await app.inject({
      method: "GET",
      url: "/_probe/ws",
      headers: { cookie: u.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_workspace_header");
    await app.close();
  });

  it("404 when user is not a member of the requested workspace", async () => {
    const app = await buildApp(env);
    await mountProbe(app);
    const u = await signUpAndGetCookie(app, { email: "ctx2@x.com", name: "C2" });
    const res = await app.inject({
      method: "GET",
      url: "/_probe/ws",
      headers: { cookie: u.cookie, "x-workspace-id": "ws_does_not_exist" },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("happy path returns membership for owner", async () => {
    const app = await buildApp(env);
    await mountProbe(app);
    const u = await signUpAndGetCookie(app, { email: "ctx3@x.com", name: "C3" });
    const wsId = await getOwnerWorkspaceId(u.userId);
    const res = await app.inject({
      method: "GET",
      url: "/_probe/ws",
      headers: { cookie: u.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, workspaceId: wsId, role: "owner" });
    await app.close();
  });
});
