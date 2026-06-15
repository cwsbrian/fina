import { describe, expect, it } from "vitest";
import { IAP_PRICING, STRIPE_PRICING } from "./pricing.js";

describe("pricing display constants", () => {
  it("keeps Stripe web pricing separate from native IAP pricing", () => {
    expect(STRIPE_PRICING.pro.displayPrice).toBe("$7");
    expect(STRIPE_PRICING.max.displayPrice).toBe("$15");
    expect(IAP_PRICING.pro.displayPrice).toBe("$7.99");
    expect(IAP_PRICING.max.displayPrice).toBe("$16.99");
  });
});
