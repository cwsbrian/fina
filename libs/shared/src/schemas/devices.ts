import { z } from "zod";

/** Body for POST /devices. Mobile sends on every launch (after permission
 *  grant + Expo token retrieval). API upserts by (userId, expoPushToken). */
export const RegisterDeviceBody = z.object({
  expoPushToken: z.string().min(1, "expoPushToken required"),
  platform: z.enum(["ios", "android"]),
}).strict();

export type RegisterDeviceBody = z.infer<typeof RegisterDeviceBody>;
