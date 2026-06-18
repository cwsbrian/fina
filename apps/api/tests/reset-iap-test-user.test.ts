import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/db.js";
import { main, resetIapTestUser } from "../src/scripts/reset-iap-test-user.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("resetIapTestUser", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("clears only native IAP state for the requested user", async () => {
    await prisma.user.create({
      data: {
        id: "tester-1",
        email: "tester@test.com",
        name: "Tester",
        isPlanMismatch: true,
        iapAppleAccountToken: "apple-token",
        iapGoogleObfuscatedId: "google-token",
      },
    });
    await prisma.subscription.createMany({
      data: [
        {
          userId: "tester-1",
          tier: "max",
          source: "iap_apple",
          sourceSubscriptionId: "apple-sub",
          status: "active",
          currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
          environment: "Sandbox",
        },
        {
          userId: "tester-1",
          tier: "pro",
          source: "stripe",
          sourceSubscriptionId: "stripe-sub",
          status: "active",
          currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
          environment: "Production",
        },
      ],
    });
    await prisma.userDevice.create({
      data: {
        userId: "tester-1",
        clientDeviceId: "device-1",
        platform: "ios",
        lastIapIntegrityCheckedAt: new Date(),
        lastIapIntegrityResult: "mismatched",
        lastIapIntegritySubscriptionUpdatedAt: new Date(),
      },
    });

    const result = await resetIapTestUser(" Tester@Test.Com ");

    expect(result).toEqual({
      id: "tester-1",
      email: "tester@test.com",
      deletedNativeSubscriptions: 1,
      clearedIapDeviceStates: 1,
    });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: "tester-1" } }),
    ).resolves.toMatchObject({
      isPlanMismatch: false,
      iapAppleAccountToken: null,
      iapGoogleObfuscatedId: null,
    });
    await expect(
      prisma.subscription.findMany({ where: { userId: "tester-1" } }),
    ).resolves.toHaveLength(1);
    await expect(
      prisma.subscription.findFirstOrThrow({ where: { userId: "tester-1" } }),
    ).resolves.toMatchObject({ source: "stripe", sourceSubscriptionId: "stripe-sub" });
    await expect(
      prisma.userDevice.findFirstOrThrow({ where: { userId: "tester-1" } }),
    ).resolves.toMatchObject({
      lastIapIntegrityCheckedAt: null,
      lastIapIntegrityResult: null,
      lastIapIntegritySubscriptionUpdatedAt: null,
    });
  });

  it("prints a JSON result from positional CLI args", async () => {
    await prisma.user.create({
      data: {
        id: "tester-2",
        email: "tester2@test.com",
        name: "Tester 2",
        isPlanMismatch: true,
      },
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await main(["tester2@test.com"]);

    expect(log).toHaveBeenCalledWith(
      JSON.stringify(
        {
          id: "tester-2",
          email: "tester2@test.com",
          deletedNativeSubscriptions: 0,
          clearedIapDeviceStates: 0,
        },
        null,
        2,
      ),
    );
    log.mockRestore();
  });

  it("fails when the user does not exist", async () => {
    await expect(resetIapTestUser("missing@test.com")).rejects.toThrow(
      "User not found: missing@test.com",
    );
  });
});
