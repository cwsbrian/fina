import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { localMidnightToUtc } from "./periods.js";

const Args = z.object({
  /** ISO date 'YYYY-MM-DD' to pause until (inclusive). Mutually exclusive with indefinite. */
  until: z.string().date().optional().describe("YYYY-MM-DD date to snooze until."),
  /** True = pause indefinitely. Mutually exclusive with until. */
  indefinite: z.boolean().optional().describe("Pause indefinitely until user toggles off."),
});

type Args = z.infer<typeof Args>;

type Result =
  | {
      ok: true;
      snoozeUntil: string | null;
      pauseEnabled: boolean;
    }
  | {
      ok: false;
      error: string;
    };

export const pauseDailyBrief: ToolDef<Args, Result> = {
  name: "pauseDailyBrief",
  description:
    "Pause the user's daily morning brief, either until a specific date or indefinitely. " +
    "Pass `until` (YYYY-MM-DD) for a one-shot snooze, OR `indefinite: true` for a long pause. " +
    "Exactly one of the two must be specified.",
  args: Args,
  async run(ctx, args) {
    // Validate mutual exclusivity here (zod allows both to be optional).
    const hasUntil = args.until !== undefined;
    const hasIndef = args.indefinite === true;
    if (hasUntil === hasIndef) {
      return { ok: false, error: "invalid_args: exactly one of `until` or `indefinite` required" };
    }

    if (hasIndef) {
      await prisma.user.update({
        where: { id: ctx.userId },
        data: { pauseEnabled: true, snoozeUntil: null },
      });
      return { ok: true, snoozeUntil: null, pauseEnabled: true };
    } else {
      // hasUntil: convert YYYY-MM-DD to UTC noon in user's tz.
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: ctx.userId },
        select: { tz: true },
      });
      const [y, m, d] = args.until!.split("-").map(Number);
      const midnight = localMidnightToUtc(y!, m!, d!, user.tz);
      const noon = new Date(midnight.getTime() + 12 * 60 * 60 * 1000);
      await prisma.user.update({
        where: { id: ctx.userId },
        data: { snoozeUntil: noon, pauseEnabled: false },
      });
      return { ok: true, snoozeUntil: args.until!, pauseEnabled: false };
    }
  },
};
