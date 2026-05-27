// Per-model Gemini pricing. Update whenever Google publishes new rates.
// Values are USD per 1M tokens. Source: ai.google.dev/pricing.
//
// Used only for accounting (LlmCallLog.costUsd); cap evaluation reads the
// summed cost, never recomputes from tokens. So an outdated price here
// understates spend but never breaks the gate.

type Price = {
  /** USD per 1,000,000 input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1,000,000 output (response) tokens. */
  outputPerMillion: number;
};

const PRICING: Record<string, Price> = {
  "gemini-2.5-flash":      { inputPerMillion: 0.075, outputPerMillion: 0.30 },
  "gemini-2.5-flash-lite": { inputPerMillion: 0.04,  outputPerMillion: 0.15 },
  "gemini-2.5-pro":        { inputPerMillion: 1.25,  outputPerMillion: 10.0 },
};

/** Fallback when the model isn't in the table — bias toward over-charging so
 *  unknown models don't slip past the cap. Matches Pro pricing. */
const UNKNOWN_MODEL_FALLBACK: Price = PRICING["gemini-2.5-pro"]!;

export function costUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model] ?? UNKNOWN_MODEL_FALLBACK;
  return (
    (inputTokens * p.inputPerMillion + outputTokens * p.outputPerMillion) /
    1_000_000
  );
}

/** Exposed for tests + ops scripts that audit recent spend without
 *  recomputing from token counts. */
export function pricingFor(model: string): Price {
  return PRICING[model] ?? UNKNOWN_MODEL_FALLBACK;
}
