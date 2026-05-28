import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { customRange } from "../src/chat/tools/periods.js";

describe("customRange", () => {
  let userId: string;

  beforeEach(async () => {
    userId = `cr-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: userId, email: `${userId}@t.co`, name: "CR", tz: "America/Toronto" },
    });
  });

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("returns a UTC midnight pair in the user's tz for a valid range", async () => {
    const { gte, lt } = await customRange(userId, "2026-05-01", "2026-06-01");
    // Toronto is UTC-4 in May (EDT), so local midnight May 1 = UTC 04:00 May 1.
    expect(gte.toISOString()).toBe("2026-05-01T04:00:00.000Z");
    expect(lt.toISOString()).toBe("2026-06-01T04:00:00.000Z");
  });

  it("rejects malformed since with which-arg context", async () => {
    await expect(customRange(userId, "2026/05/01", "2026-06-01")).rejects.toThrow(
      /invalid_date_format.*since.*"2026\/05\/01"/,
    );
  });

  it("rejects malformed until with which-arg context", async () => {
    await expect(customRange(userId, "2026-05-01", "not-a-date")).rejects.toThrow(
      /invalid_date_format.*until.*"not-a-date"/,
    );
  });

  it("rejects impossible calendar dates (Feb 30, Apr 31, month 13)", async () => {
    await expect(customRange(userId, "2026-02-30", "2026-06-01")).rejects.toThrow(
      /invalid_date_format.*since/,
    );
    await expect(customRange(userId, "2026-05-01", "2026-04-31")).rejects.toThrow(
      /invalid_date_format.*until/,
    );
    await expect(customRange(userId, "2026-13-01", "2026-12-01")).rejects.toThrow(
      /invalid_date_format.*since/,
    );
  });

  it("rejects until == since (zero-length range)", async () => {
    await expect(customRange(userId, "2026-05-15", "2026-05-15")).rejects.toThrow(
      /invalid_date_range/,
    );
  });

  it("rejects until < since", async () => {
    await expect(customRange(userId, "2026-05-15", "2026-05-01")).rejects.toThrow(
      /invalid_date_range/,
    );
  });

  it("error message includes both since and until for invalid_date_range", async () => {
    // Order in the message is "until (X) ... since (Y)" — assert both
    // dates appear without depending on order.
    const promise = customRange(userId, "2026-05-15", "2026-05-01");
    await expect(promise).rejects.toThrow(/2026-05-15/);
    await expect(
      customRange(userId, "2026-05-15", "2026-05-01"),
    ).rejects.toThrow(/2026-05-01/);
  });
});
