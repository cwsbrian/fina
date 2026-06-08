import { describe, expect, it } from "vitest";

import { costUsd, pricingFor } from "../src/llm/pricing.js";

describe("LLM pricing", () => {
  it("accounts DeepSeek V4 Flash at official cache-miss pricing", () => {
    expect(pricingFor("deepseek-v4-flash")).toEqual({
      cacheHitInputPerMillion: 0.0028,
      cacheMissInputPerMillion: 0.14,
      outputPerMillion: 0.28,
    });
    expect(costUsd("deepseek-v4-flash", 1_000_000, 1_000_000)).toBeCloseTo(
      0.42,
      6,
    );
  });

  it("applies DeepSeek V4 Flash cache-hit pricing when cache tokens are known", () => {
    expect(
      costUsd("deepseek-v4-flash", 1_000_000, 100_000, {
        inputCacheHitTokens: 600_000,
        inputCacheMissTokens: 400_000,
      }),
    ).toBeCloseTo(0.08568, 6);
  });

  it("falls back to DeepSeek V4 Pro pricing for unknown models", () => {
    expect(pricingFor("unknown-model")).toEqual({
      cacheHitInputPerMillion: 0.003625,
      cacheMissInputPerMillion: 0.435,
      outputPerMillion: 0.87,
    });
  });
});
