import { z } from "zod";
import { ROLES } from "../roles.js";

// Mirrors apps/api/src/routes/workspaces.ts.

export const PatchMemberRoleBody = z.object({
  role: z.enum(ROLES),
});

export const PatchWorkspaceCurrencyBody = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export const CreateWorkspaceBody = z.object({
  name: z.string().trim().min(1).max(80),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
});

export type PatchMemberRoleInput = z.infer<typeof PatchMemberRoleBody>;
export type PatchWorkspaceCurrencyInput = z.infer<typeof PatchWorkspaceCurrencyBody>;
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceBody>;
