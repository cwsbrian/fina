import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { firstOfMonthDateInTz } from "../src/chat/tools/periods.js";

describe("firstOfMonthDateInTz", () => {
  let userId: string;

  beforeEach(async () => {
    const stamp = `fom-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "FOM", tz: "America/Toronto" },
    });
    userId = stamp;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns May 1 for a Toronto user mid-May with offset 0", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, 0);
    expect(d.toISOString()).toBe("2026-05-01T12:00:00.000Z");
  });

  it("returns April 1 for offset -1", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, -1);
    expect(d.toISOString()).toBe("2026-04-01T12:00:00.000Z");
  });

  it("returns June 1 for offset +1", async () => {
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, 1);
    expect(d.toISOString()).toBe("2026-06-01T12:00:00.000Z");
  });

  it("rolls year on December → next-month offset", async () => {
    vi.setSystemTime(new Date("2026-12-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, 1);
    expect(d.toISOString()).toBe("2027-01-01T12:00:00.000Z");
  });

  it("rolls year on January → previous-month offset", async () => {
    vi.setSystemTime(new Date("2026-01-15T12:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, -1);
    expect(d.toISOString()).toBe("2025-12-01T12:00:00.000Z");
  });

  it("uses user-local month boundary (Toronto vs UTC)", async () => {
    // 2026-05-01T03:00:00Z = Apr 30 23:00 local Toronto → user's month is April.
    vi.setSystemTime(new Date("2026-05-01T03:00:00Z"));
    const d = await firstOfMonthDateInTz(userId, 0);
    expect(d.toISOString()).toBe("2026-04-01T12:00:00.000Z");
  });
});
