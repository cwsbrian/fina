import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Mock effectiveTier — we're testing the gate logic, not the DB read.
vi.mock("../src/auth/tier.js", () => ({
  effectiveTier: vi.fn(),
}));

import { effectiveTier } from "../src/auth/tier.js";
import { checkBackgroundSyncGate } from "../src/cron/tier-gate.js";
import { prisma } from "../src/db.js";
import { disconnect, truncateAll } from "./helpers/db.js";

beforeEach(async () => {
  await truncateAll();
  vi.mocked(effectiveTier).mockReset();
});

afterAll(async () => {
  await disconnect();
  vi.restoreAllMocks();
});

async function seedPlaidItem(opts: { graceEndsAt?: Date; withMembership?: boolean } = {}) {
  const suffix = Math.random().toString(36).slice(2);
  const user = await prisma.user.create({
    data: { id: `user-gate-${suffix}`, email: `gate-${suffix}@test.fina`, emailVerified: true },
  });
  const workspace = await prisma.workspace.create({ data: { name: "Gate workspace" } });
  if (opts.withMembership !== false) {
    await prisma.membership.create({
      data: { workspaceId: workspace.id, userId: user.id, role: "owner" },
    });
  }
  const item = await prisma.plaidItem.create({
    data: {
      workspaceId: workspace.id,
      connectedBy: user.id,
      accessTokenCiphertext: Buffer.from([1]),
      accessTokenIv: Buffer.from([2]),
      itemId: `item-${Math.random()}`,
      institutionId: "ins_gate",
      institutionName: "Gate Bank",
      status: "active",
      billingGraceEndsAt: opts.graceEndsAt,
    },
  });
  return { userId: user.id, itemId: item.id };
}

describe("checkBackgroundSyncGate", () => {
  it("active trial with Plaid entitlement → { ok: true }", async () => {
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "max",
      source: "trial",
      trialActive: true,
      trialEndsAt: new Date(Date.now() + 86_400_000),
      plaidItemLimit: 10,
    });
    expect(await checkBackgroundSyncGate("u1")).toEqual({ ok: true });
  });

  it("pro subscription can background sync", async () => {
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "pro",
      source: "paid",
      trialActive: false,
      trialEndsAt: null,
      plaidItemLimit: 1,
    });
    expect(await checkBackgroundSyncGate("u-pro")).toEqual({ ok: true });
  });

  it("free user cannot background sync", async () => {
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "free",
      source: "default",
      trialActive: false,
      trialEndsAt: null,
      plaidItemLimit: 0,
    });
    expect(await checkBackgroundSyncGate("u-free")).toEqual({ ok: false, reason: "no_plaid_entitlement" });
  });

  it("expired trial without Plaid entitlement → { ok: false, reason: 'no_plaid_entitlement' }", async () => {
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "free",
      source: "default",
      trialActive: false,
      trialEndsAt: new Date(Date.now() - 1000),  // in the past
      plaidItemLimit: 0,
    });
    expect(await checkBackgroundSyncGate("u2")).toEqual({ ok: false, reason: "no_plaid_entitlement" });
  });

  it("free user can sync a valid item during billing grace", async () => {
    const seeded = await seedPlaidItem({ graceEndsAt: new Date(Date.now() + 86_400_000) });
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "free",
      source: "default",
      trialActive: false,
      trialEndsAt: null,
      plaidItemLimit: 0,
    });

    expect(await checkBackgroundSyncGate(seeded.userId, seeded.itemId)).toEqual({
      ok: true,
      billingGrace: true,
    });
  });

  it("rejects sync when the connected user no longer belongs to the workspace", async () => {
    const seeded = await seedPlaidItem({ withMembership: false });
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "pro",
      source: "paid",
      trialActive: false,
      trialEndsAt: null,
      plaidItemLimit: 1,
    });

    expect(await checkBackgroundSyncGate(seeded.userId, seeded.itemId)).toEqual({
      ok: false,
      reason: "invalid_plaid_item_owner",
    });
  });
});
