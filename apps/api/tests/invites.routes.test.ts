import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";

vi.mock("../src/email/invite.js", async () => {
  const sent: unknown[] = [];
  return {
    sendInviteEmail: vi.fn(async (input: unknown) => {
      sent.push(input);
    }),
    __sent: sent,
  };
});
import * as inviteEmailModule from "../src/email/invite.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

function lastSentToken(): string {
  const fn = inviteEmailModule.sendInviteEmail as unknown as ReturnType<typeof vi.fn>;
  const lastCall = fn.mock.calls.at(-1);
  if (!lastCall) throw new Error("sendInviteEmail was not called");
  const arg = lastCall[0] as { token: string };
  return arg.token;
}

describe("invites routes", () => {
  beforeEach(async () => {
    await truncateAll();
    (inviteEmailModule as unknown as { __sent: unknown[] }).__sent.length = 0;
    (inviteEmailModule.sendInviteEmail as unknown as ReturnType<typeof vi.fn>).mockClear();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("POST /workspaces/:id/invites — owner creates + email is sent", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o@x.com", name: "O" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "Guest@x.com", role: "editor" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.invite).toMatchObject({ invitedEmail: "guest@x.com", invitedRole: "editor" });
    expect(typeof body.invite.id).toBe("string");

    expect(inviteEmailModule.sendInviteEmail).toHaveBeenCalledTimes(1);
    const sentInput = (inviteEmailModule.sendInviteEmail as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(sentInput).toMatchObject({ to: "guest@x.com", workspaceName: "O's workspace" });
    await app.close();
  });

  it("POST — 403 when non-owner attempts", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2@x.com", name: "O2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const member = await signUpAndGetCookie(app, { email: "m2@x.com", name: "M2" });
    await prisma.membership.create({
      data: { userId: member.userId, workspaceId: wsId, role: "editor" },
    });
    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: member.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "g@x.com", role: "viewer" }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("POST — email send failure compensates (invite revoked, 502 returned)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o2b@x.com", name: "O2b" });
    const wsId = await getOwnerWorkspaceId(owner.userId);

    const fail = inviteEmailModule.sendInviteEmail as ReturnType<typeof vi.fn>;
    fail.mockImplementationOnce(async () => {
      throw new Error("Resend down");
    });

    const res = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "g2b@x.com", role: "viewer" }),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("email_send_failed");

    // No pending invite should remain — retry should be possible.
    const pending = await prisma.invite.count({
      where: { workspaceId: wsId, invitedEmail: "g2b@x.com", status: "pending" },
    });
    expect(pending).toBe(0);

    // Retry with same email succeeds (no duplicate_invite block).
    const retry = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "g2b@x.com", role: "viewer" }),
    });
    expect(retry.statusCode).toBe(201);
    await app.close();
  });

  it("POST — 409 duplicate invite", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o3@x.com", name: "O3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const headers = {
      cookie: owner.cookie,
      "x-workspace-id": wsId,
      "content-type": "application/json",
    };
    const first = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers,
      payload: JSON.stringify({ email: "g3@x.com", role: "viewer" }),
    });
    expect(first.statusCode).toBe(201);
    const dup = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers,
      payload: JSON.stringify({ email: "g3@x.com", role: "editor" }),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("duplicate_invite");
    await app.close();
  });

  it("GET /workspaces/:id/invites — owner sees pending list", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o4@x.com", name: "O4" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "p@x.com", role: "viewer" }),
    });
    const res = await app.inject({
      method: "GET",
      url: `/workspaces/${wsId}/invites`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().invites).toHaveLength(1);
    await app.close();
  });

  it("DELETE /workspaces/:id/invites/:inviteId — owner revokes", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o5@x.com", name: "O5" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "p5@x.com", role: "viewer" }),
    });
    const inviteId = created.json().invite.id;
    const res = await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/invites/${inviteId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });
    expect(res.statusCode).toBe(204);
    const reread = await prisma.invite.findUniqueOrThrow({ where: { id: inviteId } });
    expect(reread.status).toBe("revoked");
    await app.close();
  });

  it("GET /invites/by-token/:token — returns preview when authenticated and email matches", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o6@x.com", name: "O6" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "guest6@x.com", role: "editor" }),
    });
    const rawToken = lastSentToken();
    const guest = await signUpAndGetCookie(app, { email: "guest6@x.com", name: "G6" });

    const res = await app.inject({
      method: "GET",
      url: `/invites/by-token/${encodeURIComponent(rawToken)}`,
      headers: { cookie: guest.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      status: "pending",
      workspaceName: "O6's workspace",
      invitedRole: "editor",
      emailMatch: true,
    });
    await app.close();
  });

  it("GET — emailMatch=false when authenticated as different user", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7@x.com", name: "O7" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "expected7@x.com", role: "viewer" }),
    });
    const rawToken = lastSentToken();
    const wrong = await signUpAndGetCookie(app, { email: "wrong@x.com", name: "W" });

    const res = await app.inject({
      method: "GET",
      url: `/invites/by-token/${encodeURIComponent(rawToken)}`,
      headers: { cookie: wrong.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().emailMatch).toBe(false);
    await app.close();
  });

  it("GET — 404 for unknown token", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "u@x.com", name: "U" });
    const res = await app.inject({
      method: "GET",
      url: "/invites/by-token/not-a-real-token",
      headers: { cookie: u.cookie },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("GET — unauthenticated returns preview with emailMatch=null (so the sign-up form can pre-fill the invited email)", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o7b@x.com", name: "O7b" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "guest7b@x.com", role: "viewer" }),
    });
    const sentInput = (inviteEmailModule.sendInviteEmail as ReturnType<typeof vi.fn>).mock.calls
      .at(-1)![0] as { token: string };
    const rawToken = sentInput.token;

    const res = await app.inject({
      method: "GET",
      url: `/invites/by-token/${encodeURIComponent(rawToken)}`,
      // no cookie — anonymous request
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "pending",
      workspaceName: "O7b's workspace",
      inviterEmail: "o7b@x.com",
      invitedEmail: "guest7b@x.com",
      invitedRole: "viewer",
      emailMatch: null,
    });
    await app.close();
  });

  it("POST /invites/by-token/:token/accept — happy path creates membership", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o8@x.com", name: "O8" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "guest8@x.com", role: "editor" }),
    });
    const rawToken = lastSentToken();
    const guest = await signUpAndGetCookie(app, { email: "guest8@x.com", name: "G8" });

    const res = await app.inject({
      method: "POST",
      url: `/invites/by-token/${encodeURIComponent(rawToken)}/accept`,
      headers: { cookie: guest.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ workspaceId: wsId, role: "editor" });
    const m = await prisma.membership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId: guest.userId, workspaceId: wsId } },
    });
    expect(m.role).toBe("editor");
    await app.close();
  });

  it("POST accept — 403 wrong_email when session email differs", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "o9@x.com", name: "O9" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "expected9@x.com", role: "viewer" }),
    });
    const rawToken = lastSentToken();
    const wrong = await signUpAndGetCookie(app, { email: "wrong9@x.com", name: "W" });

    const res = await app.inject({
      method: "POST",
      url: `/invites/by-token/${encodeURIComponent(rawToken)}/accept`,
      headers: { cookie: wrong.cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("wrong_email");
    await app.close();
  });

  it("POST sign-up — happy path: matching email creates user + sets session cookie", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow-su1@x.com", name: "OwSu1" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "guestSU@x.com", role: "editor" }),
    });
    const sentInput = (inviteEmailModule.sendInviteEmail as ReturnType<typeof vi.fn>).mock.calls
      .at(-1)![0] as { token: string };
    const rawToken = sentInput.token;

    const res = await app.inject({
      method: "POST",
      url: `/invites/by-token/${encodeURIComponent(rawToken)}/sign-up`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        email: "guestSU@x.com",
        password: "password-1234567890",
        name: "Guest SU",
      }),
    });
    expect(res.statusCode).toBe(200);
    // Better Auth returned a Set-Cookie for the session (forwarded by our proxy).
    const setCookie = res.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const cookieStr = Array.isArray(setCookie) ? setCookie.join("\n") : (setCookie ?? "");
    expect(cookieStr).toMatch(/better-auth\./);

    // The user row exists with the invited (lowercased) email.
    const user = await prisma.user.findFirstOrThrow({
      where: { email: { equals: "guestsu@x.com", mode: "insensitive" } },
    });
    expect(user.email.toLowerCase()).toBe("guestsu@x.com");
    await app.close();
  });

  it("POST sign-up — 403 wrong_email when submitted email differs from invite", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow-su2@x.com", name: "OwSu2" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "expected@x.com", role: "viewer" }),
    });
    const sentInput = (inviteEmailModule.sendInviteEmail as ReturnType<typeof vi.fn>).mock.calls
      .at(-1)![0] as { token: string };
    const rawToken = sentInput.token;

    const res = await app.inject({
      method: "POST",
      url: `/invites/by-token/${encodeURIComponent(rawToken)}/sign-up`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        email: "attacker@x.com", // not the invited email
        password: "password-1234567890",
      }),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("wrong_email");
    expect(body.invitedEmail).toBe("expected@x.com");

    // Verify NO user got created under either email.
    const attackerUser = await prisma.user.findFirst({
      where: { email: { equals: "attacker@x.com", mode: "insensitive" } },
    });
    expect(attackerUser).toBeNull();
    const expectedUser = await prisma.user.findFirst({
      where: { email: { equals: "expected@x.com", mode: "insensitive" } },
    });
    expect(expectedUser).toBeNull();
    await app.close();
  });

  it("POST sign-up — 404 for unknown token", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: "/invites/by-token/no-such/sign-up",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "anyone@x.com", password: "password-1234567890" }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("not_found");
    await app.close();
  });

  it("POST sign-up — 410 when invite is revoked", async () => {
    const app = await buildApp(env);
    const owner = await signUpAndGetCookie(app, { email: "ow-su3@x.com", name: "OwSu3" });
    const wsId = await getOwnerWorkspaceId(owner.userId);
    const created = await app.inject({
      method: "POST",
      url: `/workspaces/${wsId}/invites`,
      headers: {
        cookie: owner.cookie,
        "x-workspace-id": wsId,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ email: "revoked-su@x.com", role: "viewer" }),
    });
    const inviteId = created.json().invite.id;
    const sentInput = (inviteEmailModule.sendInviteEmail as ReturnType<typeof vi.fn>).mock.calls
      .at(-1)![0] as { token: string };
    const rawToken = sentInput.token;

    await app.inject({
      method: "DELETE",
      url: `/workspaces/${wsId}/invites/${inviteId}`,
      headers: { cookie: owner.cookie, "x-workspace-id": wsId },
    });

    const res = await app.inject({
      method: "POST",
      url: `/invites/by-token/${encodeURIComponent(rawToken)}/sign-up`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        email: "revoked-su@x.com",
        password: "password-1234567890",
      }),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("revoked");
    await app.close();
  });

  it("POST accept — 401 unauthenticated", async () => {
    const app = await buildApp(env);
    const res = await app.inject({
      method: "POST",
      url: "/invites/by-token/anytoken/accept",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
