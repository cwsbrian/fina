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
  it("active trial → { ok: true }", async () => {
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "pro",
      source: "trial",
      trialActive: true,
      trialEndsAt: new Date(Date.now() + 86_400_000),
    });
    expect(await checkBackgroundSyncGate("u1")).toEqual({ ok: true });
  });

  it("expired trial → { ok: false, reason: 'trial_expired' }", async () => {
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "free",
      source: "default",
      trialActive: false,
      trialEndsAt: new Date(Date.now() - 1000),  // in the past
    });
    expect(await checkBackgroundSyncGate("u2")).toEqual({ ok: false, reason: "trial_expired" });
  });

  it("no trial ever → { ok: false, reason: 'no_subscription' }", async () => {
    vi.mocked(effectiveTier).mockResolvedValueOnce({
      tier: "free",
      source: "default",
      trialActive: false,
      trialEndsAt: null,
    });
    expect(await checkBackgroundSyncGate("u3")).toEqual({ ok: false, reason: "no_subscription" });
  });
});
