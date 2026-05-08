import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

const TRIAL_DAYS = 30;

export type BootstrapInput = { userId: string };

export type BootstrapResult = {
  workspace: { id: string; name: string };
  membership: { id: string; userId: string; workspaceId: string; role: "owner" };
};

function deriveWorkspaceName(name: string | null, email: string): string {
  const trimmed = (name ?? "").trim();
  if (trimmed.length > 0) return `${trimmed}'s workspace`;
  const local = email.split("@")[0] ?? "personal";
  return `${local}'s workspace`;
}

export async function startTrialAndBootstrapWorkspace(
  input: BootstrapInput,
): Promise<BootstrapResult> {
  return await prisma.$transaction(
    async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: input.userId } });

      // Idempotent path: existing owner membership.
      const existing = await tx.membership.findFirst({
        where: { userId: user.id, role: "owner" },
        include: { workspace: true },
      });
      if (existing) {
        return {
          workspace: { id: existing.workspace.id, name: existing.workspace.name },
          membership: {
            id: existing.id,
            userId: existing.userId,
            workspaceId: existing.workspaceId,
            role: "owner",
          },
        };
      }

      const workspace = await tx.workspace.create({
        data: { name: deriveWorkspaceName(user.name, user.email) },
      });
      const membership = await tx.membership.create({
        data: { userId: user.id, workspaceId: workspace.id, role: "owner" },
      });

      // Start trial only if not already started.
      if (!user.trialStartedAt) {
        const now = new Date();
        const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
        await tx.user.update({
          where: { id: user.id },
          data: { trialStartedAt: now, trialEndsAt: trialEnd, trialConsumed: false },
        });
      }

      return {
        workspace: { id: workspace.id, name: workspace.name },
        membership: {
          id: membership.id,
          userId: membership.userId,
          workspaceId: membership.workspaceId,
          role: "owner",
        },
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
