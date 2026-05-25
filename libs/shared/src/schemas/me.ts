import { z } from "zod";
import { NotificationPrefsSchema } from "../notifications.js";

// Note: `Intl.supportedValuesOf` is Node 20+ / modern browsers. Used at schema
// build time (module load). If your env doesn't support it, replace this with
// a lazy refine() that imports Intl at call site.
const VALID_TZS = new Set<string>(
  typeof Intl !== "undefined" && typeof (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf === "function"
    ? (Intl as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone")
    : [],
);

/** Partial-update body for PATCH /me. All fields optional; absent = no change.
 *
 *  PATCH semantics for `snoozeUntil`:
 *    undefined  → no change
 *    null       → clear (User.snoozeUntil = null)
 *    "YYYY-MM-DD" → handler converts to UTC noon in user's tz, writes to
 *                   User.snoozeUntil DateTime?.
 */
export const PatchMeBody = z.object({
  morningTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:mm 24h required")
    .optional(),
  snoozeUntil: z.string().date().nullable().optional(),
  pauseEnabled: z.boolean().optional(),
  tz: z
    .string()
    .refine(
      (v) => VALID_TZS.size === 0 || VALID_TZS.has(v),
      { message: "invalid IANA tz" },
    )
    .optional(),
  notificationPrefs: NotificationPrefsSchema.optional(),
}).strict();

export type PatchMeBody = z.infer<typeof PatchMeBody>;
