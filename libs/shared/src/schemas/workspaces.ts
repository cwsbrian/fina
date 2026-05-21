import { z } from "zod";
import { ROLES } from "../roles.js";

// Mirrors apps/api/src/routes/workspaces.ts.

export const PatchMemberRoleBody = z.object({
  role: z.enum(ROLES),
});

export const PatchWorkspaceCurrencyBody = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
});

export type PatchMemberRoleInput = z.infer<typeof PatchMemberRoleBody>;
export type PatchWorkspaceCurrencyInput = z.infer<typeof PatchWorkspaceCurrencyBody>;
