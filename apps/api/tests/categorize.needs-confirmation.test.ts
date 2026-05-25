import { describe, it, expect } from "vitest";
import { computeNeedsConfirmation } from "../src/categorize/needs-confirmation.js";

const modes = ["strict", "flexible", "auto"] as const;

describe("computeNeedsConfirmation — mapping source", () => {
  for (const m of modes) {
    it(`${m} + mapping → false`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "mapping", isOther: false, priorNeedsConfirmation: null })).toBe(false);
    });
  }
});

describe("computeNeedsConfirmation — manual source", () => {
  for (const m of modes) {
    it(`${m} + manual → false`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "manual", isOther: false, priorNeedsConfirmation: null })).toBe(false);
    });
  }
});

describe("computeNeedsConfirmation — history (prior confirmed)", () => {
  for (const m of modes) {
    it(`${m} + history(prior=false) → false`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "history", isOther: false, priorNeedsConfirmation: false })).toBe(false);
    });
  }
});

describe("computeNeedsConfirmation — history (prior unconfirmed)", () => {
  it("strict + history(prior=true) → true", () => {
    expect(computeNeedsConfirmation({ mode: "strict", source: "history", isOther: false, priorNeedsConfirmation: true })).toBe(true);
  });
  it("flexible + history(prior=true) → false", () => {
    expect(computeNeedsConfirmation({ mode: "flexible", source: "history", isOther: false, priorNeedsConfirmation: true })).toBe(false);
  });
  it("auto + history(prior=true) → false", () => {
    expect(computeNeedsConfirmation({ mode: "auto", source: "history", isOther: false, priorNeedsConfirmation: true })).toBe(false);
  });
});

describe("computeNeedsConfirmation — ai source (new merchant)", () => {
  it("strict + ai → true", () => {
    expect(computeNeedsConfirmation({ mode: "strict", source: "ai", isOther: false, priorNeedsConfirmation: null })).toBe(true);
  });
  it("flexible + ai → true", () => {
    expect(computeNeedsConfirmation({ mode: "flexible", source: "ai", isOther: false, priorNeedsConfirmation: null })).toBe(true);
  });
  it("auto + ai → false", () => {
    expect(computeNeedsConfirmation({ mode: "auto", source: "ai", isOther: false, priorNeedsConfirmation: null })).toBe(false);
  });
});

describe("computeNeedsConfirmation — Other category override", () => {
  for (const m of modes) {
    it(`${m} + Other + ai → true`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "ai", isOther: true, priorNeedsConfirmation: null })).toBe(true);
    });
    it(`${m} + Other + mapping → true (override beats mapping)`, () => {
      expect(computeNeedsConfirmation({ mode: m, source: "mapping", isOther: true, priorNeedsConfirmation: null })).toBe(true);
    });
  }
});
