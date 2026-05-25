import { describe, expect, it } from "vitest";
import { resolveNotificationPrefs, DEFAULT_NOTIFICATION_PREFS } from "./notifications.js";

describe("resolveNotificationPrefs", () => {
  it("null → all defaults", () => {
    expect(resolveNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("undefined → all defaults", () => {
    expect(resolveNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("non-object inputs (string/number/array) → all defaults", () => {
    expect(resolveNotificationPrefs("foo")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(resolveNotificationPrefs(42)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(resolveNotificationPrefs([])).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("empty object → all defaults", () => {
    expect(resolveNotificationPrefs({})).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("partial { morningBrief: false } → that key false, others default", () => {
    const out = resolveNotificationPrefs({ morningBrief: false });
    expect(out.morningBrief).toBe(false);
    expect(out.largeCharges).toBe(true);
    expect(out.bankReconnect).toBe(true);
    expect(out.workspaceInvites).toBe(true);
    expect(out.trialExpiring).toBe(true);
    expect(out.goalMilestones).toBe(true);
    expect(out.transactionAdded).toBe(true);
    expect(out.productUpdates).toBe(true);
  });

  it("non-boolean values for known keys are ignored (default kept)", () => {
    const out = resolveNotificationPrefs({ morningBrief: "yes", largeCharges: 0 });
    expect(out.morningBrief).toBe(true);  // "yes" rejected → default
    expect(out.largeCharges).toBe(true);  // 0 rejected → default
  });

  it("unknown keys are silently dropped from the result", () => {
    const out = resolveNotificationPrefs({ foo: false, bar: true, morningBrief: false });
    expect(out.morningBrief).toBe(false);
    // Result shape matches the 8-key contract exactly — no extra keys leak.
    expect(Object.keys(out).sort()).toEqual(
      Object.keys(DEFAULT_NOTIFICATION_PREFS).sort(),
    );
  });
});
