import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { assertMembership, MembershipError } from "../src/auth/membership.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

describe("assertMembership", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("returns membership when user is owner of workspace", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "u1@x.com", name: "U1" });
    const m = await prisma.membership.findFirstOrThrow({ where: { userId: user.userId } });

    const result = await assertMembership({
      userId: user.userId,
      workspaceId: m.workspaceId,
      requiredRole: "owner",
    });
    expect(result.role).toBe("owner");
    await app.close();
  });

  it("throws when user is not a member", async () => {
    const app = await buildApp(env);
    const user = await signUpAndGetCookie(app, { email: "u2@x.com", name: "U2" });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    await expect(
      assertMembership({
        userId: user.userId,
        workspaceId: otherWs.id,
        requiredRole: "viewer",
      }),
    ).rejects.toThrow(MembershipError);
    await app.close();
  });

  it("throws when role is below required", async () => {
    const ws = await prisma.workspace.create({ data: { name: "Shared" } });
    const u = await prisma.user.create({
      data: { id: "u3", email: "u3@x.com", emailVerified: true, name: "U3" },
    });
    await prisma.membership.create({
      data: { userId: u.id, workspaceId: ws.id, role: "viewer" },
    });
    await expect(
      assertMembership({
        userId: u.id,
        workspaceId: ws.id,
        requiredRole: "owner",
      }),
    ).rejects.toThrow(MembershipError);
  });
});
