import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Role } from "@fina/shared";
import { assertMembership, MembershipError, type AssertedMembership } from "./membership.js";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(statusCode: number, code: string, message?: string) {
    super(message ?? code);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export type WorkspaceContext = {
  session: { userId: string; email: string };
  membership: AssertedMembership;
};

export type RequireOpts = { requiredRole: Role };

function buildHeadersFromRequest(req: FastifyRequest): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") h.set(k, v);
    else if (Array.isArray(v)) h.set(k, v.join(", "));
  }
  return h;
}

export async function requireSession(
  req: FastifyRequest,
  app: FastifyInstance,
): Promise<{ userId: string; email: string }> {
  const headers = buildHeadersFromRequest(req);
  const s = await app.fina.auth.api.getSession({ headers });
  if (!s?.user) throw new HttpError(401, "unauthenticated");
  return { userId: s.user.id, email: s.user.email };
}

export async function requireWorkspaceContext(
  req: FastifyRequest,
  app: FastifyInstance,
  opts: RequireOpts,
): Promise<WorkspaceContext> {
  const session = await requireSession(req, app);
  const wsId = req.headers["x-workspace-id"];
  if (typeof wsId !== "string" || wsId.length === 0) {
    throw new HttpError(400, "missing_workspace_header", "X-Workspace-Id header required");
  }
  try {
    const membership = await assertMembership({
      userId: session.userId,
      workspaceId: wsId,
      requiredRole: opts.requiredRole,
    });
    return { session, membership };
  } catch (e) {
    if (e instanceof MembershipError) {
      if (e.code === "no_membership") {
        throw new HttpError(404, "no_membership", e.message);
      }
      if (e.code === "insufficient_role") {
        throw new HttpError(403, "insufficient_role", e.message);
      }
    }
    throw e;
  }
}
