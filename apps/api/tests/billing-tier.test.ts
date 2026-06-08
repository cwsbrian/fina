import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { randomUUID } from "crypto";
import { prisma } from "../src/db.js";
import { computeEffectiveTier, effectiveTier } from "../src/auth/tier.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("EffectiveTier with subscriptions", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  async function createUser(opts: { trialEndsAt?: Date | null } = {}) {
    return prisma.user.create({
      data: {
        id: randomUUID(),
        email: `u${Date.now()}-${Math.random()}@example.com`,
        emailVerified: true,
        trialEndsAt: opts.trialEndsAt ?? null,
      },
    });
  }

  async function createSub(userId: string, opts: {
    tier: "pro" | "max";
    status: "trialing" | "active" | "past_due" | "canceled" | "unpaid" | "incomplete";
    cancelAtPeriodEnd?: boolean;
  }) {
    return prisma.subscription.create({
      data: {
        userId,
        tier: opts.tier,
        source: "stripe",
        sourceSubscriptionId: `sub_${Math.random()}`,
        status: opts.status as any,
        currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
        cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? false,
      },
    });
  }

  it("returns free when no trial and no subscription", async () => {
    const user = await createUser();
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("free");
    expect(t.source).toBe("default");
  });

  it("returns pro+trial when trial is active (no sub)", async () => {
    const user = await createUser({ trialEndsAt: new Date(Date.now() + 10 * 86400_000) });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");
    expect(t.source).toBe("trial");
    expect(t.trialActive).toBe(true);
  });

  it("trial wins over paid sub when both active", async () => {
    const user = await createUser({ trialEndsAt: new Date(Date.now() + 10 * 86400_000) });
    await createSub(user.id, { tier: "pro", status: "active" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");
    expect(t.source).toBe("trial");
  });

  it("returns pro+paid for active pro sub (no trial)", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "pro", status: "active" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("pro");
    expect(t.source).toBe("paid");
    expect(t.plaidItemLimit).toBe(5);
    expect(t.weeklyLlmBudgetCad).toBe(0.5);
  });

  it("returns max+paid for active max sub (no trial)", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "max", status: "active" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("max");
    expect(t.source).toBe("paid");
    expect(t.plaidItemLimit).toBe(20);
    expect(t.weeklyLlmBudgetCad).toBe(2);
  });

  it("trialing status counts as active", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "max", status: "trialing" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("max");
    expect(t.source).toBe("paid");
  });

  it("past_due status keeps user paid (Smart Retries grace)", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "max", status: "past_due" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("max");
    expect(t.source).toBe("paid");
  });

  it("canceled status drops user to free", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "max", status: "canceled" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("free");
    expect(t.source).toBe("default");
  });

  it("incomplete status does not grant paid tier", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "max", status: "incomplete" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("free");
  });

  it("unpaid status does not grant paid tier", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "max", status: "unpaid" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("free");
  });

  it("cancelAtPeriodEnd=true keeps user paid until period ends", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "max", status: "active", cancelAtPeriodEnd: true });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("max");
    expect(t.source).toBe("paid");
  });

  it("highest tier wins among multiple active subs", async () => {
    const user = await createUser();
    await createSub(user.id, { tier: "pro", status: "active" });
    await createSub(user.id, { tier: "max", status: "active" });
    const t = await effectiveTier(user.id);
    expect(t.tier).toBe("max");
  });
});
