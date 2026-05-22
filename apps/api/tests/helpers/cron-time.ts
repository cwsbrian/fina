import { prisma } from "../../src/db.js";

/** Returns the current HH:mm in the given tz. Tests that pre-seed a user
 *  with morningTime=now should call this immediately before invoking the
 *  cron, and update the user if the minute has rolled over since seeding,
 *  to avoid minute-boundary test flakes. */
export async function currentLocalHHmm(tz: string): Promise<string> {
  const partsInTz = (await import("../../src/chat/tools/periods.js")).partsInTz;
  const p = partsInTz(new Date(), tz);
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** Re-syncs a user's morningTime to the *current* HH:mm. */
export async function syncMorningTimeToNow(userId: string, tz: string): Promise<void> {
  const now = await currentLocalHHmm(tz);
  await prisma.user.update({ where: { id: userId }, data: { morningTime: now } });
}
