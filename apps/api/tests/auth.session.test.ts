import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { buildApp } from "../src/server.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

describe("Better Auth integration", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("sign-up creates user + workspace + owner membership + trial via post-create hook", async () => {
    const app = await buildApp(env);
    const { userId, email } = await signUpAndGetCookie(app, {
      email: "hook@example.com",
      name: "Hook",
    });

    const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(u.email).toBe(email);
    expect(u.trialStartedAt).not.toBeNull();
    expect(u.trialEndsAt).not.toBeNull();

    const memberships = await prisma.membership.findMany({ where: { userId } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.role).toBe("owner");
    await app.close();
  });

  it("session cookie authenticates subsequent requests", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "ses@example.com", name: "Ses" });
    const res = await app.inject({
      method: "GET",
      url: "/api/auth/get-session",
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user?.id).toBe(user.userId);
    await app.close();
  });

  it("rejects /me without a session", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
