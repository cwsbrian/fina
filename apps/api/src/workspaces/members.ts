import type { Role } from "@fina/shared";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

// Workspace-owner cardinality is enforced at the DB layer by the partial unique
// index `memberships_one_owner_per_workspace` (see migration
// 20260511131712_add_invites). That index guarantees AT MOST one owner per
// workspace — but it does NOT guarantee ≥ 1 owner. To prevent zero-owner state
// under concurrent transferOwner + updateMemberRole/removeMember, the latter
// two functions condition their write on `role: { not: "owner" }` inside a
// transaction. If a concurrent transfer promoted the target to owner between
// our read and write, count === 0 and we surface last_owner. transferOwner
// itself uses demote-then-promote so it never sees a 2-owner state.

export type MembersCode =
  | "not_found"
  | "last_owner"
  | "use_transfer"
  | "not_owner"
  | "same_user"
  | "conflict";

export class MembersServiceError extends Error {
  readonly code: MembersCode;
  constructor(code: MembersCode, message?: string) {
    super(message ?? code);
    this.name = "MembersServiceError";
    this.code = code;
  }
}

export type MemberView = {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  joinedAt: Date;
};

const ROLE_ORDER: Record<Role, number> = { owner: 0, editor: 1, viewer: 2 };

export async function listMembers(input: { workspaceId: string }): Promise<MemberView[]> {
  const rows = await prisma.membership.findMany({
    where: { workspaceId: input.workspaceId },
    include: { user: true },
  });
  return rows
    .map((r) => ({
      userId: r.userId,
      email: r.user.email,
      name: r.user.name,
      role: r.role as Role,
      joinedAt: r.createdAt,
    }))
    .sort((a, b) => {
      const ra = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
      return ra !== 0 ? ra : a.email.localeCompare(b.email);
    });
}

export type UpdateRoleInput = {
  workspaceId: string;
  targetUserId: string;
  newRole: Role;
};

export async function updateMemberRole(input: UpdateRoleInput): Promise<void> {
  if (input.newRole === "owner") {
    throw new MembersServiceError("use_transfer", "use transferOwner to make someone an owner");
  }
  await prisma.$transaction(async (tx) => {
    // Find target FIRST so we can distinguish not_found from last_owner.
    const target = await tx.membership.findUnique({
      where: { userId_workspaceId: { userId: input.targetUserId, workspaceId: input.workspaceId } },
    });
    if (!target) throw new MembersServiceError("not_found", "member not found");

    // Conditional update: only succeeds if the row is STILL not an owner.
    // If it became owner via concurrent transferOwner, the count is 0
    // and we surface last_owner (the workspace would otherwise have zero owners).
    const result = await tx.membership.updateMany({
      where: {
        userId: input.targetUserId,
        workspaceId: input.workspaceId,
        role: { not: "owner" },
      },
      data: { role: input.newRole },
    });
    if (result.count === 0) {
      throw new MembersServiceError("last_owner", "cannot demote the last owner");
    }
  });
}

export async function removeMember(input: {
  workspaceId: string;
  targetUserId: string;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await tx.membership.findUnique({
      where: { userId_workspaceId: { userId: input.targetUserId, workspaceId: input.workspaceId } },
    });
    if (!target) throw new MembersServiceError("not_found", "member not found");

    const result = await tx.membership.deleteMany({
      where: {
        userId: input.targetUserId,
        workspaceId: input.workspaceId,
        role: { not: "owner" },
      },
    });
    if (result.count === 0) {
      throw new MembersServiceError("last_owner", "cannot remove the last owner");
    }
  });
}

export type TransferInput = {
  workspaceId: string;
  currentOwnerId: string;
  newOwnerId: string;
};

/**
 * Atomically swap owner. Race safety comes from the partial unique index
 * `memberships_one_owner_per_workspace`: any concurrent transfer that tries
 * to insert a second owner row triggers P2002, which we surface as `conflict`.
 * Demote-then-promote order is intentional — it never leaves the table with
 * two owners (the demote happens first, then the promote claims the index).
 */
export async function transferOwner(input: TransferInput): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      const current = await tx.membership.findUnique({
        where: {
          userId_workspaceId: { userId: input.currentOwnerId, workspaceId: input.workspaceId },
        },
      });
      if (!current || current.role !== "owner") {
        throw new MembersServiceError("not_owner", "caller is not the owner of this workspace");
      }
      if (input.currentOwnerId === input.newOwnerId) {
        throw new MembersServiceError("same_user", "cannot transfer ownership to yourself");
      }
      const next = await tx.membership.findUnique({
        where: {
          userId_workspaceId: { userId: input.newOwnerId, workspaceId: input.workspaceId },
        },
      });
      if (!next) {
        throw new MembersServiceError("not_found", "target user is not a member");
      }
      await tx.membership.update({
        where: { id: current.id },
        data: { role: "editor" },
      });
      await tx.membership.update({
        where: { id: next.id },
        data: { role: "owner" },
      });
    });
  } catch (e) {
    // Concurrent transfer raced us and won the partial-unique index.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new MembersServiceError("conflict", "another owner change is in flight");
    }
    throw e;
  }
}
