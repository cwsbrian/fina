import { describe, expect, it } from "vitest";

import { billingRecoveryForMe } from "../src/billing/recovery.js";
import { maskBillingRecoveryEmail } from "../src/billing/recovery.js";

describe("billingRecoveryForMe", () => {
  it("masks account emails before exposing them in recovery UI", () => {
    expect(maskBillingRecoveryEmail(" CWSBrian@Gmail.com ")).toBe("c******n@gmail.com");
    expect(maskBillingRecoveryEmail("ab@example.com")).toBe("a*@example.com");
  });

  it("offers native restore for an iOS mismatch without a local subscription row", () => {
    const recovery = billingRecoveryForMe(
      { isPlanMismatch: true, planMismatchAccountEmailMasked: null },
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

  it("includes the masked bound account email when known", () => {
    const recovery = billingRecoveryForMe(
      {
        isPlanMismatch: true,
        planMismatchAccountEmailMasked: "c******n@gmail.com",
      },
      null,
      null,
      "ios",
    );

    expect(recovery.boundAccountEmailMasked).toBe("c******n@gmail.com");
  });
});
