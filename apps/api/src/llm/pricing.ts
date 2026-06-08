// Per-model LLM pricing. Update whenever providers publish new rates.
// Values are USD per 1M tokens. Source: api-docs.deepseek.com/quick_start/pricing.
//
// Used only for accounting (LlmCallLog.costUsd); cap evaluation reads the
// summed cost, never recomputes from tokens. So an outdated price here
// understates spend but never breaks the gate.

type Price = {
  /** USD per 1,000,000 input tokens served from provider prompt cache. */
  cacheHitInputPerMillion: number;
  /** USD per 1,000,000 input tokens not served from provider prompt cache. */
  cacheMissInputPerMillion: number;
  /** USD per 1,000,000 output (response) tokens. */
  outputPerMillion: number;
};

const PRICING: Record<string, Price> = {
  "deepseek-v4-flash": {
    cacheHitInputPerMillion: 0.0028,
    cacheMissInputPerMillion: 0.14,
    outputPerMillion: 0.28,
  },
  "deepseek-v4-pro": {
    cacheHitInputPerMillion: 0.003625,
    cacheMissInputPerMillion: 0.435,
    outputPerMillion: 0.87,
  },
};

/** Fallback when the model isn't in the table — bias toward over-charging so
 *  unknown models don't slip past the cap. */
const UNKNOWN_MODEL_FALLBACK: Price = PRICING["deepseek-v4-pro"]!;

export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  opts: {
    inputCacheHitTokens?: number;
    inputCacheMissTokens?: number;
  } = {},
): number {
  const p = PRICING[model] ?? UNKNOWN_MODEL_FALLBACK;
  const cacheHitTokens = Math.max(0, opts.inputCacheHitTokens ?? 0);
  const explicitMissTokens = opts.inputCacheMissTokens;
  const cacheMissTokens = Math.max(
    0,
    explicitMissTokens ?? inputTokens - cacheHitTokens,
  );
  return (
    (
      cacheHitTokens * p.cacheHitInputPerMillion +
      cacheMissTokens * p.cacheMissInputPerMillion +
      outputTokens * p.outputPerMillion
    ) /
    1_000_000
  );
}

/** Exposed for tests + ops scripts that audit recent spend without
 *  recomputing from token counts. */
export function pricingFor(model: string): Price {
  return PRICING[model] ?? UNKNOWN_MODEL_FALLBACK;
}
