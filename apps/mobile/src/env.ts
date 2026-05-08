import { z } from "zod";

const Schema = z.object({
  EXPO_PUBLIC_API_URL: z.string().url(),
});

export const env = Schema.parse({
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
});
