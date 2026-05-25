import type { FastifyInstance } from "fastify";
import { CreateInviteBody, InviteSignUpBody } from "@fina/shared";
import { prisma } from "../db.js";
import { HttpError, requireSession, requireWorkspaceContext } from "../auth/context.js";
import {
  createInvite,
  listInvites,
  revokeInvite,
  getInviteByToken,
  acceptInviteByToken,
  acceptInviteById,
  listIncomingInvites,
  InviteServiceError,
} from "../workspaces/invites.js";
import { sendInviteEmail } from "../email/invite.js";
import { sendWorkspaceInvitePush } from "../push/send.js";
import { displayName } from "@fina/shared";
import { logError } from "../logger.js";

function mapInviteError(e: unknown): { statusCode: number; code: string } {
  if (e instanceof InviteServiceError) {
    switch (e.code) {
      case "not_found":
        return { statusCode: 404, code: "not_found" };
      case "already_member":
      case "duplicate_invite":
        return { statusCode: 409, code: e.code };
      case "invalid_role":
        return { statusCode: 400, code: "invalid_role" };
      case "expired":
      case "revoked":
      case "consumed":
      case "wrong_email":
        return { statusCode: 403, code: e.code };
      default: {
        // Compile-time exhaustiveness — adding a new InviteCode without
        // updating this switch is a TS error here, not a silent 500.
        const _exhaustive: never = e.code;
        void _exhaustive;
      }
    }
  }
  return { statusCode: 500, code: "internal" };
}

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces/:id/invites", async (req, reply) => {
    const params = req.params as { id: string };
    const parsed = CreateInviteBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      // Reject inviting yourself by email — `createInvite` also rejects via already_member,
      // but a clearer error helps clients.
      if (parsed.data.email.toLowerCase() === ctx.session.email.toLowerCase()) {
        return reply.code(409).send({ error: "already_member" });
      }
      const invite = await createInvite({
        workspaceId: ctx.membership.workspaceId,
        invitedById: ctx.session.userId,
        invitedEmail: parsed.data.email,
        invitedRole: parsed.data.role,
      });
      const ws = await prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.membership.workspaceId },
      });
      const inviter = await prisma.user.findUniqueOrThrow({ where: { id: ctx.session.userId } });
      try {
        await sendInviteEmail({
          apiKey: app.fina.env.RESEND_API_KEY,
          from: app.fina.env.EMAIL_FROM,
          to: invite.invitedEmail,
          inviterEmail: inviter.email,
          inviterName: inviter.name,
          workspaceName: ws.name,
          token: invite.token,
          webAppUrl: app.fina.env.WEB_APP_URL,
        });
      } catch (sendErr) {
        // Compensating action: revoke the freshly-created invite so the user
        // can retry with the same email instead of getting `duplicate_invite`
        // forever. Best-effort — log but don't shadow the original error.
        try {
          await revokeInvite({
            workspaceId: ctx.membership.workspaceId,
            inviteId: invite.id,
          });
        } catch (revokeErr) {
          logError({ err: revokeErr }, `failed to revoke invite after email send failure (inviteId=${invite.id})`);
        }
        logError({ err: sendErr }, `invite email send failed (inviteId=${invite.id})`);
        return reply.code(502).send({ error: "email_send_failed" });
      }
      // Best-effort push to the invitee IF they already have an account.
      // Wrapped + caught so a push failure never blocks the invite flow.
      try {
        const invitee = await prisma.user.findUnique({
          where: { email: invite.invitedEmail },
          select: { id: true },
        });
        if (invitee) {
          await sendWorkspaceInvitePush(
            app.fina.env,
            invitee.id,
            displayName({ name: inviter.name, email: inviter.email }),
            ws.name,
          );
        }
      } catch (pushErr) {
        logError({ err: pushErr, inviteId: invite.id }, "invite push send failed");
      }

      return reply.code(201).send({
        invite: {
          id: invite.id,
          invitedEmail: invite.invitedEmail,
          invitedRole: invite.invitedRole,
          expiresAt: invite.expiresAt.toISOString(),
        },
      });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapInviteError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.get("/workspaces/:id/invites", async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      const invites = await listInvites({ workspaceId: ctx.membership.workspaceId });
      return {
        invites: invites.map((i) => ({
          id: i.id,
          invitedEmail: i.invitedEmail,
          invitedRole: i.invitedRole,
          expiresAt: i.expiresAt.toISOString(),
          createdAt: i.createdAt.toISOString(),
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.delete("/workspaces/:id/invites/:inviteId", async (req, reply) => {
    const params = req.params as { id: string; inviteId: string };
    try {
      const ctx = await requireWorkspaceContext(req, app, { requiredRole: "owner" });
      if (ctx.membership.workspaceId !== params.id) {
        return reply.code(400).send({ error: "workspace_mismatch" });
      }
      await revokeInvite({
        workspaceId: ctx.membership.workspaceId,
        inviteId: params.inviteId,
      });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapInviteError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });

  app.get("/invites/by-token/:token", async (req, reply) => {
    const params = req.params as { token: string };
    try {
      // Allow unauthenticated reads — the bearer token IS the security boundary,
      // and the invitee needs the email + workspace name + role BEFORE signing
      // up so the sign-in form can pre-fill (and lock) the email field. Same
      // model as Slack/Notion invite previews. emailMatch is null when no
      // session is present.
      let session: { userId: string; email: string } | null = null;
      try {
        session = await requireSession(req, app);
      } catch (e) {
        if (!(e instanceof HttpError) || e.code !== "unauthenticated") throw e;
      }
      const view = await getInviteByToken(params.token);
      if (!view) return reply.code(404).send({ error: "not_found" });
      return {
        status: view.status,
        workspaceName: view.workspaceName,
        inviterEmail: view.inviterEmail,
        invitedEmail: view.invitedEmail,
        invitedRole: view.invitedRole,
        expiresAt: view.expiresAt.toISOString(),
        emailMatch: session ? session.email.toLowerCase() === view.invitedEmail : null,
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post("/invites/by-token/:token/sign-up", async (req, reply) => {
    const params = req.params as { token: string };
    const parsed = InviteSignUpBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

    const view = await getInviteByToken(params.token);
    if (!view) return reply.code(404).send({ error: "not_found" });
    if (view.status === "revoked") return reply.code(410).send({ error: "revoked" });
    if (view.status === "accepted") return reply.code(410).send({ error: "consumed" });
    if (view.status === "expired") return reply.code(410).send({ error: "expired" });

    // Server-side enforcement: the submitted email MUST match the invitedEmail.
    // The form's readonly input is just UX — the real guarantee is here. If the
    // client tampered with the form (devtools, direct API call), the response
    // tells them clearly what's wrong instead of silently signing them up under
    // a different identity.
    if (parsed.data.email.trim().toLowerCase() !== view.invitedEmail) {
      return reply.code(403).send({
        error: "wrong_email",
        invitedEmail: view.invitedEmail,
      });
    }

    // Proxy to Better Auth's sign-up with the (now-validated) email. Forward
    // status + headers (Set-Cookie) + body so the browser ends up with the
    // same session as a normal sign-up.
    const url = new URL("/api/auth/sign-up/email", app.fina.env.BETTER_AUTH_URL);
    const upstream = await app.fina.auth.handler(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: view.invitedEmail,
          password: parsed.data.password,
          name: parsed.data.name ?? view.invitedEmail.split("@")[0],
        }),
      }),
    );
    reply.code(upstream.status);
    // See comment in server.ts /api/auth/* bridge — set-cookie needs the
    // getSetCookie() array path so the browser receives each cookie separately.
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      reply.header(key, value);
    });
    const setCookies = upstream.headers.getSetCookie();
    if (setCookies.length > 0) reply.header("set-cookie", setCookies);
    return reply.send(Buffer.from(await upstream.arrayBuffer()));
  });

  // Incoming invites for the authenticated user — by email match.
  // Lets the web home / mobile UI surface pending invites for someone
  // who finished signup but didn't accept on the way through.
  app.get("/me/incoming-invites", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const invites = await listIncomingInvites(session.email);
      return {
        invites: invites.map((i) => ({
          id: i.id,
          workspaceId: i.workspaceId,
          workspaceName: i.workspaceName,
          inviterEmail: i.inviterEmail,
          inviterName: i.inviterName,
          invitedRole: i.invitedRole,
          expiresAt: i.expiresAt.toISOString(),
          createdAt: i.createdAt.toISOString(),
        })),
      };
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.post<{ Params: { id: string } }>(
    "/me/incoming-invites/:id/accept",
    async (req, reply) => {
      try {
        const session = await requireSession(req, app);
        const result = await acceptInviteById({
          inviteId: req.params.id,
          acceptingUserId: session.userId,
          acceptingEmail: session.email,
        });
        return reply.code(200).send({
          workspaceId: result.workspaceId,
          role: result.role,
        });
      } catch (e) {
        if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
        const m = mapInviteError(e);
        return reply.code(m.statusCode).send({ error: m.code });
      }
    },
  );

  app.post("/invites/by-token/:token/accept", async (req, reply) => {
    const params = req.params as { token: string };
    try {
      const session = await requireSession(req, app);
      const result = await acceptInviteByToken({
        token: params.token,
        acceptingUserId: session.userId,
        acceptingEmail: session.email,
      });
      return reply.code(200).send({ workspaceId: result.workspaceId, role: result.role });
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      const m = mapInviteError(e);
      return reply.code(m.statusCode).send({ error: m.code });
    }
  });
}
