import { describe, it, expect } from "vitest";
import { IAPCheckoutBody, IAPRestoreBody } from "./iap.js";

describe("IAPCheckoutBody", () => {
  it("accepts a valid iOS body", () => {
    const r = IAPCheckoutBody.safeParse({
      platform: "ios",
      productId: "fina_pro_monthly",
      receipt: "eyJhbGciOiJFUzI1NiJ9.payload.sig",
    });
    expect(r.success).toBe(true);
  });
  it("rejects unknown productId", () => {
    const r = IAPCheckoutBody.safeParse({
      platform: "ios",
      productId: "free_monthly",
      receipt: "x",
    });
    expect(r.success).toBe(false);
  });
  it("rejects empty receipt", () => {
    const r = IAPCheckoutBody.safeParse({
      platform: "android",
      productId: "fina_pro_monthly",
      receipt: "",
    });
    expect(r.success).toBe(false);
  });
});

describe("IAPRestoreBody", () => {
  it("accepts 1-20 purchases", () => {
    const purchases = Array.from({ length: 20 }, (_, i) => ({
      productId: "fina_pro_monthly" as const,
      receipt: `r${i}`,
    }));
    const r = IAPRestoreBody.safeParse({ platform: "ios", purchases });
    expect(r.success).toBe(true);
  });
  it("rejects empty purchases array", () => {
    const r = IAPRestoreBody.safeParse({ platform: "ios", purchases: [] });
    expect(r.success).toBe(false);
  });
  it("rejects more than 20 purchases", () => {
    const purchases = Array.from({ length: 21 }, () => ({
      productId: "max_monthly" as const,
      receipt: "r",
    }));
    const r = IAPRestoreBody.safeParse({ platform: "ios", purchases });
    expect(r.success).toBe(false);
  });
});
