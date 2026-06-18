import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { HttpError } from "../../src/auth/context.js";
import { refreshDueIapSubscriptionsForUser } from "../../src/iap/refresh.js";
import { truncateAll, disconnect } from "../helpers/db.js";

describe("refreshDueIapSubscriptionsForUser", () => {
  beforeEach(async () => {
    await truncateAll();
    process.env.APPLE_ENV = "sandbox";
  });

  afterAll(async () => {
    await disconnect();
  });

  it("cancels a due Apple IAP row when App Store Connect no longer has the transaction", async () => {
    const now = new Date("2026-06-18T23:40:00.000Z");
    await prisma.user.create({
      data: {
        id: "iap-refresh-missing-user",
        email: "iap-refresh-missing@example.com",
        emailVerified: true,
      },
    });
    const sub = await prisma.subscription.create({
      data: {
        userId: "iap-refresh-missing-user",
        tier: "max",
        source: "iap_apple",
        sourceSubscriptionId: "2000001190999920",
        status: "active",
        currentPeriodEnd: new Date("2026-06-18T23:31:58.000Z"),
        cancelAtPeriodEnd: false,
        pendingTier: "pro",
        pendingTierAt: new Date("2026-06-18T23:35:00.000Z"),
        environment: "Sandbox",
      },
    });
    const appleClient = {
      getSubscriptionStatus: vi
        .fn()
        .mockRejectedValue(new HttpError(400, "invalid_receipt", "asc no transaction")),
    };

    const refreshed = await refreshDueIapSubscriptionsForUser("iap-refresh-missing-user", {
      now,
      appleClient,
    });

    expect(refreshed).toBe(1);
    expect(appleClient.getSubscriptionStatus).toHaveBeenCalledWith("2000001190999920");
    const updated = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(updated.status).toBe("canceled");
    expect(updated.currentPeriodEnd).toEqual(now);
    expect(updated.cancelAtPeriodEnd).toBe(false);
    expect(updated.pendingTier).toBeNull();
    expect(updated.pendingTierAt).toBeNull();
  });
});
