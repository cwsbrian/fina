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
  kind: z.enum(["personal", "business"]).default("personal"),
  taxCountry: z.enum(["CA", "US"]).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "business" && !value.taxCountry) {
    ctx.addIssue({ code: "custom", path: ["taxCountry"], message: "required_for_business" });
  }
  if (value.kind === "personal" && value.taxCountry) {
    ctx.addIssue({ code: "custom", path: ["taxCountry"], message: "personal_has_no_tax_country" });
  }
});

export const PatchWorkspaceKindBody = z.object({
  kind: z.enum(["personal", "business"]),
  taxCountry: z.enum(["CA", "US"]).optional(),
}).superRefine((value, ctx) => {
  if (value.kind === "business" && !value.taxCountry) {
    ctx.addIssue({ code: "custom", path: ["taxCountry"], message: "required_for_business" });
  }
});

export type PatchMemberRoleInput = z.infer<typeof PatchMemberRoleBody>;
export type PatchWorkspaceCurrencyInput = z.infer<typeof PatchWorkspaceCurrencyBody>;
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceBody>;
export type PatchWorkspaceKindInput = z.infer<typeof PatchWorkspaceKindBody>;
