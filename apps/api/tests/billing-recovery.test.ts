import { describe, expect, it } from "vitest";

import { billingRecoveryForMe } from "../src/billing/recovery.js";

describe("billingRecoveryForMe", () => {
  it("offers native restore for an iOS mismatch without a local subscription row", () => {
    const recovery = billingRecoveryForMe(
      { isPlanMismatch: true },
      null,
      null,
      "ios",
    );

    expect(recovery).toMatchObject({
      locked: true,
      reason: "plan_mismatch",
      source: "iap_apple",
      action: "restore_iap",
    });
  });
});
