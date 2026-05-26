import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { truncateAll } from "../helpers/db.js";

describe("IAP schema migration", () => {
  beforeEach(async () => { await truncateAll(); });

  it("accepts iapAppleAccountToken on User", async () => {
    const u = await prisma.user.create({
      data: { id: "u1", email: "u1@test", iapAppleAccountToken: "tok-1" },
    });
    expect(u.iapAppleAccountToken).toBe("tok-1");
  });

  it("enforces unique iapAppleAccountToken across users", async () => {
    await prisma.user.create({ data: { id: "u1", email: "u1@test", iapAppleAccountToken: "tok-1" } });
    await expect(
      prisma.user.create({ data: { id: "u2", email: "u2@test", iapAppleAccountToken: "tok-1" } }),
    ).rejects.toThrow();
  });

  it("defaults Subscription.environment to Production", async () => {
    const u = await prisma.user.create({ data: { id: "u1", email: "u1@test" } });
    const s = await prisma.subscription.create({
      data: {
        userId: u.id, tier: "lite", source: "stripe", sourceSubscriptionId: "sub_1",
        status: "active", currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      },
    });
    expect(s.environment).toBe("Production");
  });

  it("stores and queries IapDeletedBinding tombstones", async () => {
    await prisma.iapDeletedBinding.create({ data: { source: "iap_apple", tokenHash: "h1" } });
    const hit = await prisma.iapDeletedBinding.findUnique({
      where: { source_tokenHash: { source: "iap_apple", tokenHash: "h1" } },
    });
    expect(hit).not.toBeNull();
  });
});
