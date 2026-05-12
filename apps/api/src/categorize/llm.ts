import { GoogleGenAI, Type } from "@google/genai";
import type { Env } from "../env.js";

export type LLMTransaction = {
  id: string;
  merchantRaw: string;
  amount: number;
  occurredAtISO: string; // YYYY-MM-DD
};

export type LLMResult = { tx_id: string; category: string };

/**
 * Call Gemini 2.5 Flash Lite to categorize a batch of transactions.
 * Merchant strings are JSON-encoded (prompt-injection defense).
 * Throws on errors — caller catches and leaves tx uncategorized.
 */
export async function callGeminiCategorize(
  env: Env,
  categoryNames: string[],
  txs: LLMTransaction[],
): Promise<LLMResult[]> {
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

  const userPayload = {
    categories: categoryNames,
    transactions: txs.map((t) => ({
      tx_id: t.id,
      merchant: t.merchantRaw,
      amount: t.amount,
      date: t.occurredAtISO,
    })),
  };

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-lite",
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
        "Positive amount = expense, negative = income/refund. " +
        "Use exact category names from the categories list. If genuinely unclear, use 'Other'.",
    },
    contents: [
      { role: "user", parts: [{ text: JSON.stringify(userPayload) }] },
    ],
  });

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
