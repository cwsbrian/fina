import { GoogleGenAI, Type } from "@google/genai";
import type { Env } from "../env.js";
import { logLlmCall } from "../llm/budget.js";

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

/** Category vocabulary split by type so Gemini can be constrained to
 *  pick from the right bucket based on transaction direction. */
export type LLMCategoryVocab = {
  expense: string[];
  income: string[];
};

export type LLMResult = { tx_id: string; category: string };

/**
 * Call Gemini 2.5 Flash Lite to categorize a batch of transactions.
 * Merchant strings are JSON-encoded (prompt-injection defense).
 * Throws on errors — caller catches and leaves tx uncategorized.
 */
export async function callGeminiCategorize(
  env: Env,
  vocab: LLMCategoryVocab,
  txs: LLMTransaction[],
  /** Workspace owner — accounts for the LLM spend against their weekly cap.
   *  Null when no owner can be resolved (test fixtures only); in that case
   *  we still run the call but skip accounting. */
  ownerUserId: string | null,
): Promise<LLMResult[]> {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const model = "gemini-2.5-flash-lite";

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

  const response = await ai.models.generateContent({
    model,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          results: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                tx_id: { type: Type.STRING },
                category: { type: Type.STRING },
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
        "If genuinely unclear, use 'Other' from the matching type's list.",
    },
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
      outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    }).catch(() => {});
  }

  const text = response.text;
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("Gemini returned no text");
  }
  const parsed = JSON.parse(text) as { results?: LLMResult[] };
  if (!Array.isArray(parsed.results)) {
    throw new Error(`Gemini response missing results array: ${text.slice(0, 200)}`);
  }
  return parsed.results;
}
