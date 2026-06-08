import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { effectiveTier, requirePaidTier, requireProTier, computeEffectiveTier } from "../src/auth/tier.js";
import { HttpError } from "../src/auth/context.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

// File-level lifecycle (Plan 2 convention).
beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnect();
});

describe("requirePaidTier / effectiveTier", () => {
  it("returns pro + trialActive=true on a fresh trial signup", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "pro@x.com", name: "Pro" });
    const t = await effectiveTier(u.userId);
    expect(t.tier).toBe("pro");
    expect(t.trialActive).toBe(true);
    expect(t.source).toBe("trial");
    await app.close();
  });

  it("returns free after trial expires", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "exp@x.com", name: "Exp" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    const t = await effectiveTier(u.userId);
    expect(t.tier).toBe("free");
    expect(t.trialActive).toBe(false);
    expect(t.source).toBe("default");
    await app.close();
  });

  it("requirePaidTier passes for trial-active user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "pro2@x.com", name: "Pro2" });
    await expect(requirePaidTier(u.userId)).resolves.toBeUndefined();
    await app.close();
  });

  it("requirePaidTier throws 402 upgrade_required for free user", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "free@x.com", name: "Free" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    await expect(requirePaidTier(u.userId)).rejects.toMatchObject({
      statusCode: 402,
      code: "upgrade_required",
    });
    expect((await requirePaidTier(u.userId).catch((e) => e)) as HttpError).toBeInstanceOf(HttpError);
    await app.close();
  });

  it("requireProTier compatibility helper now allows paid Pro", async () => {
    const app = await buildApp(env);
    const u = await signUpAndGetCookie(app, { email: "pro-paid@x.com", name: "Pro Paid" });
    await prisma.user.update({
      where: { id: u.userId },
      data: { trialEndsAt: new Date(Date.now() - 1000), trialConsumed: true },
    });
    await prisma.subscription.create({
      data: {
        userId: u.userId,
        tier: "pro",
        source: "stripe",
        sourceSubscriptionId: `sub_pro_${u.userId}`,
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
        cancelAtPeriodEnd: false,
      },
    });
    await expect(requireProTier(u.userId)).resolves.toBeUndefined();
    await app.close();
  });
});

describe("computeEffectiveTier — plaidItemLimit", () => {
  it("active trial → Pro limits", () => {
    const t = computeEffectiveTier({ trialEndsAt: new Date(Date.now() + 86_400_000) });
    expect(t.plaidItemLimit).toBe(5);
    expect(t.weeklyLlmBudgetCad).toBe(0.5);
  });

  it("expired trial → plaidItemLimit: 0", () => {
    const t = computeEffectiveTier({ trialEndsAt: new Date(Date.now() - 1_000) });
    expect(t.plaidItemLimit).toBe(0);
  });

  it("no trial (null) → plaidItemLimit: 0", () => {
    const t = computeEffectiveTier({ trialEndsAt: null });
    expect(t.plaidItemLimit).toBe(0);
  });

  it("paid pro subscription -> Pro limits", () => {
    const t = computeEffectiveTier(
      { trialEndsAt: null },
      [{ tier: "pro" }],
    );
    expect(t.tier).toBe("pro");
    expect(t.plaidItemLimit).toBe(5);
    expect(t.weeklyLlmBudgetCad).toBe(0.5);
  });

  it("paid max subscription -> Max limits", () => {
    const t = computeEffectiveTier(
      { trialEndsAt: null },
      [{ tier: "max" }],
    );
    expect(t.tier).toBe("max");
    expect(t.plaidItemLimit).toBe(20);
    expect(t.weeklyLlmBudgetCad).toBe(2);
  });
});
