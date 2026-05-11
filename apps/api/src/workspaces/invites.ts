import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Invite } from "@prisma/client";
import type { Role } from "@fina/shared";
import { prisma } from "../db.js";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteCode =
  | "invalid_role"
  | "already_member"
  | "duplicate_invite"
  | "not_found"
  | "expired"
  | "revoked"
  | "wrong_email"
  | "consumed";

export class InviteServiceError extends Error {
  readonly code: InviteCode;
  constructor(code: InviteCode, message?: string) {
    super(message ?? code);
    this.name = "InviteServiceError";
    this.code = code;
  }
}

function genRawToken(): string {
  // 32 bytes of entropy; base64url is ~43 chars.
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function lower(email: string): string {
  return email.trim().toLowerCase();
}

/** Flip any pending row past its TTL to `expired`. Returns nothing. */
async function flipExpiredPending(workspaceId: string, invitedEmail: string): Promise<void> {
  await prisma.invite.updateMany({
    where: {
      workspaceId,
      invitedEmail,
      status: "pending",
      expiresAt: { lte: new Date() },
    },
    data: { status: "expired" },
  });
}

export type CreateInviteInput = {
  workspaceId: string;
  invitedById: string;
  invitedEmail: string;
  invitedRole: Role;
};

/**
 * The DB row stored in `invites`. Note `tokenHash` (not raw token).
 */
export type InviteRow = Invite;

/**
 * Returned only by `createInvite` — includes the raw bearer token so the
 * route can email it. Not stored anywhere; subsequent reads only ever
 * return the hash.
 */
export type CreatedInvite = InviteRow & { token: string };

export async function createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
  if (input.invitedRole !== "editor" && input.invitedRole !== "viewer") {
    throw new InviteServiceError("invalid_role", "invited role must be editor or viewer");
  }
  const email = lower(input.invitedEmail);

  // Reject if invitee is already a member. Case-insensitive match because
  // Better Auth may store mixed-case email.
  const existingUser = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
  });
  if (existingUser) {
    const existingMembership = await prisma.membership.findUnique({
      where: {
        userId_workspaceId: { userId: existingUser.id, workspaceId: input.workspaceId },
      },
    });
    if (existingMembership) {
      throw new InviteServiceError("already_member", "user is already a member");
    }
  }

  // Flip stale-pending rows for THIS (workspace, email) before duplicate check.
  await flipExpiredPending(input.workspaceId, email);

  // App-level duplicate check (clearer error message); the partial unique
  // index `invites_one_pending_per_workspace_email` is the actual safeguard
  // under concurrency.
  const dup = await prisma.invite.findFirst({
    where: { workspaceId: input.workspaceId, invitedEmail: email, status: "pending" },
  });
  if (dup) {
    throw new InviteServiceError("duplicate_invite", "pending invite already exists");
  }

  const rawToken = genRawToken();
  try {
    const inv = await prisma.invite.create({
      data: {
        workspaceId: input.workspaceId,
        invitedById: input.invitedById,
        invitedEmail: email,
        invitedRole: input.invitedRole,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    return { ...inv, token: rawToken };
  } catch (e) {
    // Concurrent create lost the race against the partial unique index.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new InviteServiceError("duplicate_invite", "pending invite already exists");
    }
    throw e;
  }
}

export async function listInvites(input: { workspaceId: string }): Promise<InviteRow[]> {
  // Flip stale-pending rows in this workspace BEFORE listing.
  await prisma.invite.updateMany({
    where: { workspaceId: input.workspaceId, status: "pending", expiresAt: { lte: new Date() } },
    data: { status: "expired" },
  });
  const rows = await prisma.invite.findMany({
    where: { workspaceId: input.workspaceId, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  return rows;
}

export async function revokeInvite(input: { workspaceId: string; inviteId: string }): Promise<void> {
  const result = await prisma.invite.updateMany({
    where: {
      id: input.inviteId,
      workspaceId: input.workspaceId,
      status: "pending",
      expiresAt: { gt: new Date() },
    },
    data: { status: "revoked", revokedAt: new Date() },
  });
  if (result.count === 1) return;

  // Re-read to figure out the precise reason.
  const inv = await prisma.invite.findUnique({ where: { id: input.inviteId } });
  if (!inv || inv.workspaceId !== input.workspaceId) {
    throw new InviteServiceError("not_found", "invite not found");
  }
  if (inv.status === "accepted") throw new InviteServiceError("consumed", "invite already accepted");
  if (inv.status === "revoked") throw new InviteServiceError("revoked", "invite already revoked");
  // Pending-but-expired falls through here. Lazy-flip status to expired.
  if (inv.status === "pending" && inv.expiresAt.getTime() <= Date.now()) {
    await prisma.invite.update({ where: { id: inv.id }, data: { status: "expired" } });
  }
  throw new InviteServiceError("expired", "invite expired");
}

export type InviteView = InviteRow & { workspaceName: string; inviterEmail: string };

export async function getInviteByToken(rawToken: string): Promise<InviteView | null> {
  const inv = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { workspace: true, invitedBy: true },
  });
  if (!inv) return null;

  // Lazily flip pending → expired so callers always see the right status.
  let status = inv.status;
  if (status === "pending" && inv.expiresAt.getTime() <= Date.now()) {
    await prisma.invite.update({
      where: { id: inv.id },
      data: { status: "expired" },
    });
    status = "expired";
  }

  const { workspace, invitedBy, ...row } = inv;
  return {
    ...row,
    status,
    workspaceName: workspace.name,
    inviterEmail: invitedBy.email,
  };
}

export type AcceptInput = {
  token: string;
  acceptingUserId: string;
  acceptingEmail: string;
};

export type AcceptResult = {
  workspaceId: string;
  role: Role;
};

export async function acceptInviteByToken(input: AcceptInput): Promise<AcceptResult> {
  const tokenHash = hashToken(input.token);

  return await prisma.$transaction(async (tx) => {
    // Read the row (gives us workspaceId + invitedEmail + invitedRole + status).
    const inv = await tx.invite.findUnique({ where: { tokenHash } });
    if (!inv) throw new InviteServiceError("not_found", "invite not found");

    // Email mismatch is checked BEFORE the claim — we don't want a wrong-email
    // request to even attempt to consume the invite.
    if (lower(input.acceptingEmail) !== inv.invitedEmail) {
      throw new InviteServiceError("wrong_email", "session email does not match invited email");
    }

    // Pre-flight status checks for clearer errors.
    if (inv.status === "revoked") throw new InviteServiceError("revoked", "invite revoked");
    if (inv.status === "accepted") throw new InviteServiceError("consumed", "invite already accepted");
    if (inv.status === "expired" || inv.expiresAt.getTime() <= Date.now()) {
      if (inv.status === "pending") {
        await tx.invite.update({ where: { id: inv.id }, data: { status: "expired" } });
      }
      throw new InviteServiceError("expired", "invite expired");
    }

    // Atomic claim — only succeeds if the row is STILL pending. Two concurrent
    // requests will see exactly one count=1 here.
    const claim = await tx.invite.updateMany({
      where: { id: inv.id, status: "pending", expiresAt: { gt: new Date() } },
      data: {
        status: "accepted",
        acceptedAt: new Date(),
        acceptedById: input.acceptingUserId,
      },
    });
    if (claim.count === 0) {
      // Re-read to figure out the precise reason.
      const after = await tx.invite.findUniqueOrThrow({ where: { id: inv.id } });
      if (after.status === "accepted") throw new InviteServiceError("consumed", "invite already accepted");
      if (after.status === "revoked") throw new InviteServiceError("revoked", "invite revoked");
      throw new InviteServiceError("expired", "invite expired");
    }

    // Idempotent membership creation. If the user is somehow already a member
    // (e.g. accepted then re-invited and accepted again from a stale tab),
    // upsert avoids a unique-violation.
    await tx.membership.upsert({
      where: {
        userId_workspaceId: { userId: input.acceptingUserId, workspaceId: inv.workspaceId },
      },
      update: {}, // existing role is preserved
      create: {
        userId: input.acceptingUserId,
        workspaceId: inv.workspaceId,
        role: inv.invitedRole,
      },
    });

    return { workspaceId: inv.workspaceId, role: inv.invitedRole as Role };
  });
}
