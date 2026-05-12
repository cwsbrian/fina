import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import {
  listMembers,
  updateMemberRole,
  removeMember,
  transferOwner,
  MembersServiceError,
} from "../src/workspaces/members.js";

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

async function addMember(opts: {
  workspaceId: string;
  email: string;
  role: "editor" | "viewer";
}): Promise<string> {
  const u = await prisma.user.create({
    data: {
      id: `u_${Math.random().toString(36).slice(2, 10)}`,
      email: opts.email,
      emailVerified: true,
    },
  });
  await prisma.membership.create({
    data: { userId: u.id, workspaceId: opts.workspaceId, role: opts.role },
  });
  return u.id;
}

// File-level hooks shared with the second describe block (added in Task 7).
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await disconnect();
});

describe("members service: list / update / remove", () => {
  it("list — returns owner first, then editor, then viewer; sorted by role then email", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "owner@x.com", name: "Owner" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await addMember({ workspaceId: wsId, email: "vy@x.com", role: "viewer" });
    await addMember({ workspaceId: wsId, email: "ed@x.com", role: "editor" });

    const members = await listMembers({ workspaceId: wsId });
    expect(members.map((m) => `${m.role}:${m.email}`)).toEqual([
      "owner:owner@x.com",
      "editor:ed@x.com",
      "viewer:vy@x.com",
    ]);
    await app.close();
  });

  it("update — owner can promote viewer to editor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const memberId = await addMember({ workspaceId: wsId, email: "v@x.com", role: "viewer" });
    await updateMemberRole({ workspaceId: wsId, targetUserId: memberId, newRole: "editor" });
    const m = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: memberId, workspaceId: wsId } },
    });
    expect(m.role).toBe("editor");
    await app.close();
  });

  it("update — rejects newRole=owner (use transferOwner instead)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const memberId = await addMember({ workspaceId: wsId, email: "v@x.com", role: "viewer" });
    await expect(
      updateMemberRole({ workspaceId: wsId, targetUserId: memberId, newRole: "owner" as never }),
    ).rejects.toMatchObject({ code: "use_transfer" });
    await app.close();
  });

  it("update — rejects demoting the last owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      updateMemberRole({ workspaceId: wsId, targetUserId: owner.userId, newRole: "editor" }),
    ).rejects.toMatchObject({ code: "last_owner" });
    await app.close();
  });

  it("update — 404 when target is not a member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      updateMemberRole({ workspaceId: wsId, targetUserId: "u_nope", newRole: "viewer" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await app.close();
  });

  it("remove — removes a non-owner member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const memberId = await addMember({ workspaceId: wsId, email: "v@x.com", role: "viewer" });
    await removeMember({ workspaceId: wsId, targetUserId: memberId });
    const m = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: memberId, workspaceId: wsId } },
    });
    expect(m).toBeNull();
    await app.close();
  });

  it("remove — rejects removing the last owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      removeMember({ workspaceId: wsId, targetUserId: owner.userId }),
    ).rejects.toMatchObject({ code: "last_owner" });
    await app.close();
  });

  it("MembersServiceError carries a code", () => {
    const e = new MembersServiceError("last_owner", "boom");
    expect(e.code).toBe("last_owner");
  });

  it("update — race with transferOwner cannot leave zero owners", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "race1@x.com", name: "R1" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const target = await addMember({ workspaceId: wsId, email: "rt1@x.com", role: "editor" });

    // Simulate the concurrent flip: target is promoted to owner, then we try
    // to demote it. Without the conditional update, this would leave 0 owners.
    await prisma.$transaction(async (tx) => {
      await tx.membership.update({
        where: { userId_workspaceId: { userId: owner.userId, workspaceId: wsId } },
        data: { role: "editor" },
      });
      await tx.membership.update({
        where: { userId_workspaceId: { userId: target, workspaceId: wsId } },
        data: { role: "owner" },
      });
    });

    await expect(
      updateMemberRole({ workspaceId: wsId, targetUserId: target, newRole: "viewer" }),
    ).rejects.toMatchObject({ code: "last_owner" });
    const owners = await prisma.membership.count({ where: { workspaceId: wsId, role: "owner" } });
    expect(owners).toBe(1);
    await app.close();
  });

  it("remove — race with transferOwner cannot leave zero owners", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "race2@x.com", name: "R2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const target = await addMember({ workspaceId: wsId, email: "rt2@x.com", role: "editor" });

    // Same simulated flip
    await prisma.$transaction(async (tx) => {
      await tx.membership.update({
        where: { userId_workspaceId: { userId: owner.userId, workspaceId: wsId } },
        data: { role: "editor" },
      });
      await tx.membership.update({
        where: { userId_workspaceId: { userId: target, workspaceId: wsId } },
        data: { role: "owner" },
      });
    });

    await expect(
      removeMember({ workspaceId: wsId, targetUserId: target }),
    ).rejects.toMatchObject({ code: "last_owner" });
    const owners = await prisma.membership.count({ where: { workspaceId: wsId, role: "owner" } });
    expect(owners).toBe(1);
    await app.close();
  });
});

describe("members service: transferOwner", () => {
  it("happy path — atomically promotes target, demotes current owner to editor", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow@x.com", name: "OW" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const newOwnerId = await addMember({
      workspaceId: wsId,
      email: "newowner@x.com",
      role: "editor",
    });
    await transferOwner({
      workspaceId: wsId,
      currentOwnerId: owner.userId,
      newOwnerId,
    });
    const o = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: owner.userId, workspaceId: wsId } },
    });
    const n = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: newOwnerId, workspaceId: wsId } },
    });
    expect(o.role).toBe("editor");
    expect(n.role).toBe("owner");

    const owners = await prisma.membership.count({
      where: { workspaceId: wsId, role: "owner" },
    });
    expect(owners).toBe(1);
    await app.close();
  });

  it("rejects when caller is not actually the owner of the workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow2@x.com", name: "OW2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const memberId = await addMember({ workspaceId: wsId, email: "m@x.com", role: "editor" });
    await expect(
      transferOwner({
        workspaceId: wsId,
        currentOwnerId: memberId, // wrong — not the owner
        newOwnerId: memberId,
      }),
    ).rejects.toMatchObject({ code: "not_owner" });
    await app.close();
  });

  it("rejects when target is not a member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow3@x.com", name: "OW3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      transferOwner({
        workspaceId: wsId,
        currentOwnerId: owner.userId,
        newOwnerId: "u_nobody",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await app.close();
  });

  it("rejects when target is the same as current owner (no-op)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow4@x.com", name: "OW4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      transferOwner({
        workspaceId: wsId,
        currentOwnerId: owner.userId,
        newOwnerId: owner.userId,
      }),
    ).rejects.toMatchObject({ code: "same_user" });
    await app.close();
  });

  it("concurrent transfers — partial unique index keeps owner cardinality at 1", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow5@x.com", name: "OW5" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const candidateA = await addMember({
      workspaceId: wsId,
      email: "ca@x.com",
      role: "editor",
    });
    const candidateB = await addMember({
      workspaceId: wsId,
      email: "cb@x.com",
      role: "editor",
    });
    const results = await Promise.allSettled([
      transferOwner({ workspaceId: wsId, currentOwnerId: owner.userId, newOwnerId: candidateA }),
      transferOwner({ workspaceId: wsId, currentOwnerId: owner.userId, newOwnerId: candidateB }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    // Either "conflict" (lost the partial-unique race) or "not_owner" (snapshot
    // saw the original owner already demoted) is acceptable.
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(["conflict", "not_owner"]).toContain(failure.reason?.code);

    const owners = await prisma.membership.count({
      where: { workspaceId: wsId, role: "owner" },
    });
    expect(owners).toBe(1);
    await app.close();
  });
});
