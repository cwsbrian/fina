import { hasAtLeast, type Role } from "@fina/shared";
import { prisma } from "../db.js";

export class MembershipError extends Error {
  readonly statusCode: number;
  readonly code: "no_membership" | "insufficient_role";

  constructor(code: "no_membership" | "insufficient_role", message: string) {
    super(message);
    this.name = "MembershipError";
    this.code = code;
    this.statusCode = code === "no_membership" ? 404 : 403;
  }
}

export type AssertInput = {
  userId: string;
  workspaceId: string;
  requiredRole: Role;
};

export type AssertedMembership = {
  id: string;
  userId: string;
  workspaceId: string;
  role: Role;
};

export async function assertMembership(input: AssertInput): Promise<AssertedMembership> {
  const m = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: input.userId, workspaceId: input.workspaceId } },
  });
  if (!m) {
    throw new MembershipError("no_membership", "User is not a member of this workspace");
  }
  const role = m.role as Role;
  if (!hasAtLeast(role, input.requiredRole)) {
    throw new MembershipError("insufficient_role", `Role ${role} < required ${input.requiredRole}`);
  }
  return { id: m.id, userId: m.userId, workspaceId: m.workspaceId, role };
}
