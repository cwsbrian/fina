import type { Env } from "../env.js";
import { logLlmCall } from "../llm/budget.js";
import { DEFAULT_LIGHT_LLM_MODEL, generateLlmContent } from "../llm/provider.js";
import { effectiveTier } from "../auth/tier.js";
import { isPaidFeatureTier } from "@fina/shared";

export type LLMTransaction = {
  id: string;
  merchantRaw: string;
  amount: number;
  occurredAtISO: string;
  /** Optional Plaid PFC. Caller (service.ts) extracts from rawData and omits when missing. */
  pfc?: {
    primary: string;
    detailed: string;
    confidence: string; // "VERY_HIGH" | "HIGH" | "MEDIUM" | "LOW"
  };
};

/** Category vocabulary split by type so the LLM can be constrained to
 *  pick from the right bucket based on transaction direction. */
export type LLMCategoryVocab = {
  expense: string[];
  income: string[];
};

export type LLMResult = { tx_id: string; category: string };

/**
 * Call the configured light LLM to categorize a batch of transactions.
 * Merchant strings are JSON-encoded (prompt-injection defense).
 * Throws on errors — caller catches and leaves tx uncategorized.
 */
export async function callLlmCategorize(
  env: Env,
  vocab: LLMCategoryVocab,
  txs: LLMTransaction[],
  /** Workspace owner — accounts for the LLM spend against their weekly cap.
   *  Null when no owner can be resolved (test fixtures only); in that case
   *  we still run the call but skip accounting. */
  ownerUserId: string | null,
): Promise<LLMResult[]> {
  // Categorization can be reached from asynchronous Plaid webhooks after a
  // downgrade. Re-check billing at the final LLM boundary so Free accounts
  // never incur an LLM call even while Plaid cleanup is retrying.
  if (ownerUserId) {
    const tier = await effectiveTier(ownerUserId);
    if (!isPaidFeatureTier(tier.tier)) return [];
  }
  const model = env.CHAT_MODEL ?? DEFAULT_LIGHT_LLM_MODEL;

  const userPayload = {
    expense_categories: vocab.expense,
    income_categories: vocab.income,
    transactions: txs.map((t) => ({
      tx_id: t.id,
      merchant: t.merchantRaw,
      amount: t.amount,
      date: t.occurredAtISO,
      ...(t.pfc ? { plaid_hint: t.pfc } : {}),
    })),
  };

  const response = await generateLlmContent(env, {
    model,
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tx_id: { type: "string" },
              category: { type: "string" },
            },
            required: ["tx_id", "category"],
          },
        },
      },
      required: ["results"],
    },
    systemInstruction:
      "You categorize Canadian personal financial transactions. CAD currency. " +
      "Positive amount = money out (expense) — pick ONLY from expense_categories. " +
      "Negative amount = money in (income/refund) — pick ONLY from income_categories. " +
      "Never cross types. Use exact category names from the matching list. " +
      "If a transaction includes plaid_hint (Plaid's personal_finance_category with primary/detailed/confidence), " +
      "treat HIGH/VERY_HIGH as a strong hint and MEDIUM/LOW as a weak hint when mapping into our category list. " +
      "If genuinely unclear, use 'Other' from the matching type's list. " +
      "Return only valid JSON matching the requested schema with a top-level results array.",
    contents: [
      { role: "user", parts: [{ text: JSON.stringify(userPayload) }] },
    ],
  });

  if (ownerUserId) {
    void logLlmCall({
      userId: ownerUserId,
      source: "categorize",
      model,
      inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
      ...(typeof response.usageMetadata?.promptCacheHitTokenCount === "number"
        ? { inputCacheHitTokens: response.usageMetadata.promptCacheHitTokenCount }
        : {}),
      ...(typeof response.usageMetadata?.promptCacheMissTokenCount === "number"
        ? { inputCacheMissTokens: response.usageMetadata.promptCacheMissTokenCount }
        : {}),
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      usdToCadRate: env.LLM_BUDGET_USD_TO_CAD_RATE,
    }).catch(() => {});
  }

  const text = response.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("LLM returned no text");
  }
  const parsed = JSON.parse(text) as { results?: LLMResult[]; transactions?: LLMResult[] };
  const results = Array.isArray(parsed.results) ? parsed.results : parsed.transactions;
  if (!Array.isArray(results)) {
    throw new Error(`LLM response missing results array: ${text.slice(0, 200)}`);
  }
  return results;
}
