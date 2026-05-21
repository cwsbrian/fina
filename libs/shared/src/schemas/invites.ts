import { z } from "zod";

// Mirrors apps/api/src/routes/invites.ts.

export const CreateInviteBody = z.object({
  email: z.string().email(),
  role: z.enum(["editor", "viewer"]),
});

export const InviteSignUpBody = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().optional(),
});

export type CreateInviteInput = z.infer<typeof CreateInviteBody>;
export type InviteSignUpInput = z.infer<typeof InviteSignUpBody>;
