import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { grantProTrialByEmail, main } from "../src/scripts/grant-pro-trial.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("grantProTrialByEmail", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("grants a lifetime Pro trial to an existing user by default", async () => {
    await prisma.user.create({
      data: {
        id: "family-1",
        email: "family@example.com",
        name: "Family",
        trialEndsAt: new Date("2026-01-01T00:00:00Z"),
        trialConsumed: true,
      },
    });

    const updated = await grantProTrialByEmail(" Family@Example.Com ");

    expect(updated).toEqual({
      id: "family-1",
      email: "family@example.com",
      trialEndsAt: new Date("9999-12-31T23:59:59.000Z"),
      trialConsumed: false,
    });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: "family-1" } }),
    ).resolves.toMatchObject({
      trialEndsAt: new Date("9999-12-31T23:59:59.000Z"),
      trialConsumed: false,
    });
  });

  it("grants until a specific date for expiring/free testing", async () => {
    await prisma.user.create({
      data: { id: "family-until", email: "until@example.com", name: "Until" },
    });

    const updated = await grantProTrialByEmail("until@example.com", {
      until: new Date("2026-07-01T00:00:00.000Z"),
    });

    expect(updated.trialEndsAt).toEqual(new Date("2026-07-01T00:00:00.000Z"));
  });

  it("supports --days CLI args", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T00:00:00.000Z"));
    await prisma.user.create({
      data: { id: "family-3", email: "family3@example.com", name: "Family 3" },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["family3@example.com", "--days", "3"]);

    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          id: "family-3",
          email: "family3@example.com",
          trialEndsAt: "2026-06-26T00:00:00.000Z",
          trialConsumed: false,
        },
        null,
        2,
      ),
    );
    log.mockRestore();
  });

  it("prints a JSON result from positional CLI args", async () => {
    await prisma.user.create({
      data: { id: "family-2", email: "family2@example.com", name: "Family 2" },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["family2@example.com"]);

    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          id: "family-2",
          email: "family2@example.com",
          trialEndsAt: "9999-12-31T23:59:59.000Z",
          trialConsumed: false,
        },
        null,
        2,
      ),
    );
    log.mockRestore();
  });

  it("fails when the user does not exist", async () => {
    await expect(grantProTrialByEmail("missing@example.com")).rejects.toThrow(
      "User not found: missing@example.com",
    );
  });
});
