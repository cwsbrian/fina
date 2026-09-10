import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Role } from "@fina/shared";
import { prisma } from "../db.js";
import { assertMembership, MembershipError, type AssertedMembership } from "./membership.js";

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | null;
  constructor(
    statusCode: number,
    code: string,
    message?: string,
    details: Record<string, unknown> | null = null,
  ) {
    super(message ?? code);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
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
    const route = req.routeOptions.url ?? req.url;
    const isBusinessPersonalFeature =
      route.includes("/analysis") ||
      route.includes("/intents/") ||
      (req.method !== "GET" && (route.includes("/goals") || route.includes("/budget-plans")));
    if (isBusinessPersonalFeature) {
      const workspace = await prisma.workspace.findUnique({ where: { id: wsId }, select: { kind: true } });
      if (workspace?.kind === "business") {
        throw new HttpError(403, "personal_workspace_required");
      }
    }
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

export async function requireWorkspaceKind(
  workspaceId: string,
  kind: "personal" | "business",
): Promise<void> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { kind: true },
  });
  if (!workspace) throw new HttpError(404, "workspace_not_found");
  if (workspace.kind !== kind) {
    throw new HttpError(403, kind === "business" ? "business_workspace_required" : "personal_workspace_required");
  }
}

/** Scoped Fastify gate for route families that are personal-only. It runs
 * before handler-local Zod parsing so business workspaces always receive the
 * same feature-boundary response, regardless of request body shape. */
export function registerPersonalWorkspaceGate(
  app: FastifyInstance,
  opts: { allowGet: boolean },
): void {
  app.addHook("preHandler", async (req, reply) => {
    if (opts.allowGet && req.method === "GET") return;
    const workspaceId = req.headers["x-workspace-id"];
    if (typeof workspaceId !== "string" || !workspaceId) return;
    const session = await requireSession(req, app);
    const membership = await prisma.membership.findUnique({
      where: { userId_workspaceId: { userId: session.userId, workspaceId } },
      select: { workspace: { select: { kind: true } } },
    });
    if (membership?.workspace.kind === "business") {
      return reply.code(403).send({ error: "personal_workspace_required" });
    }
  });
}
