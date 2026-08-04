import { z } from "zod";

export const AppleDistributionBody = z
  .object({
    signedAppTransaction: z.string().min(1).max(50_000),
  })
  .strict();

export type AppleDistributionBody = z.infer<typeof AppleDistributionBody>;

export type AppleDistributionResponse = {
  signupEnvironment: "TEST" | "PRODUCTION";
  platform: "ios";
  buildNumber: string | null;
  storeEnvironment: "Sandbox" | "Production";
  verifiedAt: string;
};
