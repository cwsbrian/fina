import { z } from "zod";

const Schema = z.object({
  // Optional with placeholder fallback so production builds don't fail when
  // the env var isn't yet wired in the deploy environment (landing page
  // doesn't use the API). Set NEXT_PUBLIC_API_URL in Vercel for any route
  // that actually calls the backend.
  NEXT_PUBLIC_API_URL: z.string().url().default("http://localhost:4000"),
});

export const env = Schema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
