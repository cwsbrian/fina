import { GoogleGenAI } from "@google/genai";
import type { Env } from "../env.js";

const SYSTEM_INSTRUCTION =
  "You generate concise titles for chat conversations.\n" +
  "Output a single-line title of at most 5 words in the same language as the user's message.\n" +
  "No quotes, no markdown, no trailing punctuation.";

const MAX_PROMPT_CHARS = 500;

// Calls Gemini once with the SYSTEM_INSTRUCTION + the (truncated) first user
// message. Returns the raw text. Errors propagate; the orchestrator catches.
export async function callTitleLLM(env: Env, firstMessageText: string): Promise<string> {
  const userPrompt = firstMessageText.slice(0, MAX_PROMPT_CHARS);
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const model = env.CHAT_MODEL ?? "gemini-2.5-flash-lite";
  const resp = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    config: { systemInstruction: SYSTEM_INSTRUCTION },
  });
  return resp.text ?? "";
}
