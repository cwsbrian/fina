import { z } from "zod";

const Schema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
});

export const env = Schema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
});
