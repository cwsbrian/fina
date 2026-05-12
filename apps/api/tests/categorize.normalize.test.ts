import { describe, it, expect } from "vitest";
import { normalizeMerchant } from "../src/categorize/normalize.js";

describe("normalizeMerchant", () => {
  it("uppercase store with hash store ID + city + state → bare merchant", () => {
    expect(normalizeMerchant("STARBUCKS #1234 TORONTO ON")).toBe("starbucks");
  });

  it("strips hash store ID (no city/state)", () => {
    expect(normalizeMerchant("McDonald's #5152")).toBe("mcdonald's");
  });

  it("strips bare digits + state", () => {
    expect(normalizeMerchant("Walmart 1234 BC")).toBe("walmart");
  });

  it("strips Plaid alphanumeric store ID (q39 / r12 / s4 / t99)", () => {
    expect(normalizeMerchant("McDonalds q39")).toBe("mcdonalds");
    expect(normalizeMerchant("McDonalds r12")).toBe("mcdonalds");
  });

  it("strips trailing CA city from allowlist", () => {
    expect(normalizeMerchant("Tim Hortons Toronto")).toBe("tim hortons");
    expect(normalizeMerchant("Pho House Vancouver")).toBe("pho house");
  });

  it("strips trailing parenthesized location", () => {
    expect(normalizeMerchant("Pizza Pizza (Toronto)")).toBe("pizza pizza");
  });

  it("trims and collapses whitespace", () => {
    expect(normalizeMerchant("   Starbucks   ")).toBe("starbucks");
    expect(normalizeMerchant("Tim  Hortons")).toBe("tim hortons");
  });

  it("leaves clean input alone", () => {
    expect(normalizeMerchant("Amazon.ca")).toBe("amazon.ca");
    expect(normalizeMerchant("Loblaws")).toBe("loblaws");
  });

  it("loop terminates: max iters reached → returns last stable form", () => {
    const weird = "shop #1 toronto on vancouver bc";
    const out = normalizeMerchant(weird);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("empty input → empty output", () => {
    expect(normalizeMerchant("")).toBe("");
    expect(normalizeMerchant("   ")).toBe("");
  });
});
