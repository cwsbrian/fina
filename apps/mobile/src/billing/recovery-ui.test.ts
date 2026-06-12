import { describe, expect, it } from "vitest";
import type { MeDTO } from "@fina/shared";
import {
  billingRecoveryButtonLabel,
  billingRecoveryFootnote,
  billingRecoveryLockCopy,
  isBillingLocked,
} from "./recovery-ui";

function me(overrides: Partial<MeDTO>): MeDTO {
  return {
    user: {
      id: "u1",
      email: "u@example.com",
      name: null,
      tz: "America/Vancouver",
      locale: "en",
      morningTime: "08:00",
      snoozeUntil: null,
      pauseEnabled: false,
      notificationPrefs: {
        morningBrief: true,
        bankReconnect: true,
        workspaceInvites: true,
        trialExpiring: true,
        goalMilestones: true,
        largeCharges: true,
        transactionAdded: true,
        productUpdates: true,
      },
      categorizationMode: "flexible",
    },
    tier: "pro",
    trial: { active: false, endsAt: null },
    subscription: null,
    billingRecovery: {
      locked: false,
      reason: null,
      source: null,
      action: null,
      lastCheckedAt: null,
    },
    iapIntegrity: {
      isPlanMismatch: false,
      requiresCheck: false,
      lastCheckedAt: null,
    },
    ...overrides,
  };
}

describe("billing recovery UI helpers", () => {
  it("uses billingRecovery.locked for app lock decisions", () => {
    expect(
      isBillingLocked(
        me({
          billingRecovery: {
            locked: true,
            reason: "plan_mismatch",
            source: "stripe",
            action: "sync_stripe",
            lastCheckedAt: null,
          },
        }),
      ),
    ).toBe(true);
  });

  it("shows Stripe sync copy for Stripe recovery", () => {
    const locked = me({
      subscription: {
        tier: "pro",
        status: "active",
        currentPeriodEnd: new Date().toISOString(),
        cancelAtPeriodEnd: false,
        source: "stripe",
        pendingTier: null,
        pendingTierAt: null,
      },
      billingRecovery: {
        locked: true,
        reason: "plan_mismatch",
        source: "stripe",
        action: "sync_stripe",
        lastCheckedAt: null,
      },
    });
    expect(billingRecoveryButtonLabel(locked)).toBe("Sync billing");
    expect(billingRecoveryFootnote(locked, "the App Store")).toContain("web billing");
  });

  it("shows native restore copy for IAP recovery", () => {
    const locked = me({
      subscription: {
        tier: "pro",
        status: "active",
        currentPeriodEnd: new Date().toISOString(),
        cancelAtPeriodEnd: false,
        source: "iap_apple",
        pendingTier: null,
        pendingTierAt: null,
      },
      billingRecovery: {
        locked: true,
        reason: "plan_mismatch",
        source: "iap_apple",
        action: "restore_iap",
        lastCheckedAt: null,
      },
    });
    expect(billingRecoveryButtonLabel(locked)).toBe("Restore purchases");
    expect(billingRecoveryFootnote(locked, "the App Store")).toContain("App Store handles");
  });

  it("does not label unknown-source recovery as native restore", () => {
    const locked = me({
      billingRecovery: {
        locked: true,
        reason: "plan_mismatch",
        source: null,
        action: null,
        lastCheckedAt: null,
      },
    });
    expect(billingRecoveryButtonLabel(locked)).toBe("Contact support");
    expect(billingRecoveryLockCopy(locked)).toContain("could not determine");
  });
});
