import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";

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
};

describe("GET /workspaces", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns the personal workspace after signup", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ws1@x.com", name: "WS1" });
    const res = await app.inject({ method: "GET", url: "/workspaces", headers: { cookie: u.cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.workspaces)).toBe(true);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({ name: "WS1's workspace", role: "owner" });
    expect(typeof body.workspaces[0].id).toBe("string");
    await app.close();
  });

  it("returns multiple workspaces sorted by createdAt asc", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "ws2@x.com", name: "WS2" });
    const second = await prisma.workspace.create({ data: { name: "Family" } });
    await prisma.membership.create({
      data: { userId: u.userId, workspaceId: second.id, role: "editor" },
    });
    const res = await app.inject({ method: "GET", url: "/workspaces", headers: { cookie: u.cookie } });
    expect(res.statusCode).toBe(200);
    const names = res.json().workspaces.map((w: { name: string }) => w.name);
    expect(names).toEqual(["WS2's workspace", "Family"]);
    await app.close();
  });

  it("401 without session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/workspaces" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
