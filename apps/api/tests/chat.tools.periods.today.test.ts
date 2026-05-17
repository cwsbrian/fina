import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { basicPeriodRange } from "../src/chat/tools/periods.js";

describe("basicPeriodRange — today", () => {
  let userId: string;
  beforeEach(async () => {
    const stamp = `pt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "PT", tz: "America/Toronto" },
    });
    userId = u.id;
    vi.useFakeTimers();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns the Toronto local-day [00:00, 24:00) for a Toronto user", async () => {
    // Pin "now" to 2026-05-02T03:00:00Z = 2026-05-01 23:00 local Toronto.
    vi.setSystemTime(new Date("2026-05-02T03:00:00Z"));
    const r = await basicPeriodRange(userId, "today");
    // May 1 local 00:00 Toronto = 2026-05-01T04:00:00Z.
    // May 2 local 00:00 Toronto = 2026-05-02T04:00:00Z.
    expect(r.gte.toISOString()).toBe("2026-05-01T04:00:00.000Z");
    expect(r.lt.toISOString()).toBe("2026-05-02T04:00:00.000Z");
  });
});
