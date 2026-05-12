import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import {
  createInvite,
  listInvites,
  revokeInvite,
  getInviteByToken,
  InviteServiceError,
} from "../src/workspaces/invites.js";

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

// File-level hooks so multiple describe blocks (this file gets a second one in Task 5) share them
// and we disconnect Prisma exactly once per file.
beforeEach(async () => {
  await truncateAll();
});
afterAll(async () => {
  await disconnect();
});

import crypto from "node:crypto";

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

describe("invites service: create / list / revoke / lookup", () => {
  it("create — happy path; raw token returned, hash stored", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "owner@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "GUEST@x.com",
      invitedRole: "editor",
    });
    expect(inv.invitedEmail).toBe("guest@x.com");
    expect(inv.invitedRole).toBe("editor");
    expect(inv.token.length).toBeGreaterThanOrEqual(40); // raw bearer token
    expect(inv.status).toBe("pending");
    expect(inv.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // DB stores only the hash, never the raw.
    const dbRow = await prisma.invite.findUniqueOrThrow({ where: { id: inv.id } });
    expect(dbRow.tokenHash).toBe(sha256(inv.token));
    expect(dbRow.tokenHash).not.toBe(inv.token);
    await app.close();
  });

  it("create — rejects role=owner", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "g@x.com",
        invitedRole: "owner" as never,
      }),
    ).rejects.toMatchObject({ code: "invalid_role" });
    await app.close();
  });

  it("create — rejects when invitee is already a member", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m@x.com", name: "M" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "editor" },
    });
    await expect(
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "M@x.com",
        invitedRole: "editor",
      }),
    ).rejects.toMatchObject({ code: "already_member" });
    await app.close();
  });

  it("create — rejects when a pending invite already exists for that email", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g4@x.com",
      invitedRole: "viewer",
    });
    await expect(
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "G4@x.com",
        invitedRole: "editor",
      }),
    ).rejects.toMatchObject({ code: "duplicate_invite" });
    await app.close();
  });

  it("create — re-invite after the previous one expires succeeds", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4b@x.com", name: "O4b" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const first = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g4b@x.com",
      invitedRole: "viewer",
    });
    // Force the first invite past its TTL.
    await prisma.invite.update({
      where: { id: first.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // Re-invite should work — the expired pending row gets flipped to expired.
    const second = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g4b@x.com",
      invitedRole: "editor",
    });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
    const reread = await prisma.invite.findUniqueOrThrow({ where: { id: first.id } });
    expect(reread.status).toBe("expired");
    await app.close();
  });

  it("create — concurrent calls collide on the partial unique index, second resolves to duplicate_invite", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4c@x.com", name: "O4c" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const results = await Promise.allSettled([
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "race@x.com",
        invitedRole: "viewer",
      }),
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "race@x.com",
        invitedRole: "viewer",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejectedDup = results.filter(
      (r) => r.status === "rejected" && (r as PromiseRejectedResult).reason?.code === "duplicate_invite",
    ).length;
    expect(fulfilled).toBe(1);
    expect(rejectedDup).toBe(1);
    const dbCount = await prisma.invite.count({
      where: { workspaceId: wsId, invitedEmail: "race@x.com", status: "pending" },
    });
    expect(dbCount).toBe(1);
    await app.close();
  });

  it("create — rejects inviting yourself", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "self@x.com", name: "Self" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await expect(
      createInvite({
        workspaceId: wsId,
        invitedById: owner.userId,
        invitedEmail: "self@x.com",
        invitedRole: "editor",
      }),
    ).rejects.toMatchObject({ code: "already_member" });
    await app.close();
  });

  it("list — returns only live pending invites (revoked AND expired excluded)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O5" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "a@x.com",
      invitedRole: "editor",
    });
    const inv2 = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "b@x.com",
      invitedRole: "viewer",
    });
    await revokeInvite({ workspaceId: wsId, inviteId: inv2.id });
    const inv3 = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "c@x.com",
      invitedRole: "viewer",
    });
    await prisma.invite.update({
      where: { id: inv3.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const list = await listInvites({ workspaceId: wsId });
    expect(list.map((i) => i.invitedEmail)).toEqual(["a@x.com"]);
    // The list call should also have flipped the expired row's status.
    const reread3 = await prisma.invite.findUniqueOrThrow({ where: { id: inv3.id } });
    expect(reread3.status).toBe("expired");
    await app.close();
  });

  it("revoke — sets status=revoked + revokedAt", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O6" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g6@x.com",
      invitedRole: "viewer",
    });
    await revokeInvite({ workspaceId: wsId, inviteId: inv.id });
    const reread = await prisma.invite.findUniqueOrThrow({ where: { id: inv.id } });
    expect(reread.status).toBe("revoked");
    expect(reread.revokedAt).not.toBeNull();
    await app.close();
  });

  it("revoke — 404 when invite belongs to different workspace", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7@x.com", name: "O7" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g7@x.com",
      invitedRole: "viewer",
    });
    const otherWs = await prisma.workspace.create({ data: { name: "Other" } });
    await expect(
      revokeInvite({ workspaceId: otherWs.id, inviteId: inv.id }),
    ).rejects.toMatchObject({ code: "not_found" });
    await app.close();
  });

  it("getInviteByToken — returns pending; expires lazily", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o8@x.com", name: "O8" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g8@x.com",
      invitedRole: "viewer",
    });
    const fetched = await getInviteByToken(inv.token);
    expect(fetched?.id).toBe(inv.id);
    expect(fetched?.workspaceName).toBe("O8's workspace");
    expect(fetched?.inviterEmail).toBe("o8@x.com");

    // Force expiry then re-read; status should be flipped to "expired".
    await prisma.invite.update({
      where: { id: inv.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const after = await getInviteByToken(inv.token);
    expect(after?.status).toBe("expired");
    await app.close();
  });

  it("getInviteByToken — returns null for unknown token", async () => {
    const app = await buildApp(env);
    const result = await getInviteByToken("not-a-real-token");
    expect(result).toBeNull();
    await app.close();
  });

  it("revoke — rejects already-revoked invite with code=revoked", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7b@x.com", name: "O7b" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g7b@x.com",
      invitedRole: "viewer",
    });
    await revokeInvite({ workspaceId: wsId, inviteId: inv.id });
    await expect(
      revokeInvite({ workspaceId: wsId, inviteId: inv.id }),
    ).rejects.toMatchObject({ code: "revoked" });
    await app.close();
  });

  it("revoke — rejects expired invite with code=expired", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7c@x.com", name: "O7c" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g7c@x.com",
      invitedRole: "viewer",
    });
    // First, flip pending → expired by aging the row and triggering a list
    await prisma.invite.update({
      where: { id: inv.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await listInvites({ workspaceId: wsId }); // flips status to expired
    await expect(
      revokeInvite({ workspaceId: wsId, inviteId: inv.id }),
    ).rejects.toMatchObject({ code: "expired" });
    await app.close();
  });

  it("InviteServiceError carries a code", async () => {
    const e = new InviteServiceError("invalid_role", "boom");
    expect(e.code).toBe("invalid_role");
    expect(e.message).toBe("boom");
  });
});

import { acceptInviteByToken } from "../src/workspaces/invites.js";

describe("invites service: accept", () => {
  it("happy path — creates membership, marks invite consumed", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow@x.com", name: "OW" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "guest@x.com",
      invitedRole: "editor",
    });
    const guest = await signUpAndGetCookie(app, { email: "guest@x.com", name: "Guest" });

    const result = await acceptInviteByToken({
      token: inv.token,
      acceptingUserId: guest.userId,
      acceptingEmail: "Guest@x.com", // case-insensitive
    });
    expect(result.workspaceId).toBe(wsId);
    expect(result.role).toBe("editor");

    const reread = await prisma.invite.findUniqueOrThrow({ where: { id: inv.id } });
    expect(reread.status).toBe("accepted");
    expect(reread.acceptedById).toBe(guest.userId);
    expect(reread.acceptedAt).not.toBeNull();

    const member = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: guest.userId, workspaceId: wsId } },
    });
    expect(member.role).toBe("editor");
    await app.close();
  });

  it("rejects when accepting user's email differs from invite email", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow2@x.com", name: "OW2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "expected@x.com",
      invitedRole: "viewer",
    });
    const otherUser = await signUpAndGetCookie(app, { email: "wrong@x.com", name: "Wrong" });
    await expect(
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: otherUser.userId,
        acceptingEmail: "wrong@x.com",
      }),
    ).rejects.toMatchObject({ code: "wrong_email" });
    await app.close();
  });

  it("rejects revoked invite", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow3@x.com", name: "OW3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g3@x.com",
      invitedRole: "viewer",
    });
    await revokeInvite({ workspaceId: wsId, inviteId: inv.id });
    const guest = await signUpAndGetCookie(app, { email: "g3@x.com", name: "G3" });
    await expect(
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: guest.userId,
        acceptingEmail: "g3@x.com",
      }),
    ).rejects.toMatchObject({ code: "revoked" });
    await app.close();
  });

  it("rejects expired invite", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow4@x.com", name: "OW4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g4@x.com",
      invitedRole: "viewer",
    });
    await prisma.invite.update({
      where: { id: inv.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const guest = await signUpAndGetCookie(app, { email: "g4@x.com", name: "G4" });
    await expect(
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: guest.userId,
        acceptingEmail: "g4@x.com",
      }),
    ).rejects.toMatchObject({ code: "expired" });
    await app.close();
  });

  it("rejects accepting twice (already consumed)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow5@x.com", name: "OW5" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g5@x.com",
      invitedRole: "viewer",
    });
    const guest = await signUpAndGetCookie(app, { email: "g5@x.com", name: "G5" });
    await acceptInviteByToken({
      token: inv.token,
      acceptingUserId: guest.userId,
      acceptingEmail: "g5@x.com",
    });
    await expect(
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: guest.userId,
        acceptingEmail: "g5@x.com",
      }),
    ).rejects.toMatchObject({ code: "consumed" });
    await app.close();
  });

  it("concurrent double-submit — exactly one succeeds, other reports consumed", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow5b@x.com", name: "OW5b" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const inv = await createInvite({
      workspaceId: wsId,
      invitedById: owner.userId,
      invitedEmail: "g5b@x.com",
      invitedRole: "viewer",
    });
    const guest = await signUpAndGetCookie(app, { email: "g5b@x.com", name: "G5b" });
    const results = await Promise.allSettled([
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: guest.userId,
        acceptingEmail: "g5b@x.com",
      }),
      acceptInviteByToken({
        token: inv.token,
        acceptingUserId: guest.userId,
        acceptingEmail: "g5b@x.com",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejectedConsumed = results.filter(
      (r) => r.status === "rejected" && (r as PromiseRejectedResult).reason?.code === "consumed",
    ).length;
    expect(fulfilled).toBe(1);
    expect(rejectedConsumed).toBe(1);
    // Exactly one membership was created.
    const m = await prisma.membership.count({
      where: { userId: guest.userId, workspaceId: wsId },
    });
    expect(m).toBe(1);
    await app.close();
  });

  it("404 for unknown token", async () => {
    await expect(
      acceptInviteByToken({
        token: "no-such",
        acceptingUserId: "u_noop",
        acceptingEmail: "noop@x.com",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
