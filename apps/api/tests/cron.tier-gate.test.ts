import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Mock effectiveTier — we're testing the gate logic, not the DB read.
vi.mock("../src/auth/tier.js", () => ({
  effectiveTier: vi.fn(),
}));

import { effectiveTier } from "../src/auth/tier.js";
import { checkBackgroundSyncGate } from "../src/cron/tier-gate.js";

beforeEach(() => {
  vi.mocked(effectiveTier).mockReset();
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("checkBackgroundSyncGate", () => {
  it("active trial with Plaid entitlement → { ok: true }", async () => {
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "pro",
      source: "trial",
      trialActive: true,
      trialEndsAt: new Date(Date.now() + 86_400_000),
      plaidItemLimit: 10,
    });
    expect(await checkBackgroundSyncGate("u1")).toEqual({ ok: true });
  });

  it("lite subscription can background sync", async () => {
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "lite",
      source: "paid",
      trialActive: false,
      trialEndsAt: null,
      plaidItemLimit: 1,
    });
    expect(await checkBackgroundSyncGate("u-lite")).toEqual({ ok: true });
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
});
