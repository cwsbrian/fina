import type { Env } from "../env.js";
import { logLlmCall } from "../llm/budget.js";
import { DEFAULT_LIGHT_LLM_MODEL, generateLlmContent } from "../llm/provider.js";

const SYSTEM_INSTRUCTION =
  "You generate concise titles for chat conversations.\n" +
  "Output a single-line title of at most 5 words in the same language as the user's message.\n" +
  "No quotes, no markdown, no trailing punctuation.";

const MAX_PROMPT_CHARS = 500;

// Calls the light LLM once with the SYSTEM_INSTRUCTION + the (truncated) first user
// message. Returns the raw text. Errors propagate; the orchestrator catches.
// Records spend against the user's weekly LLM cap as a side effect.
export async function callTitleLLM(
  env: Env,
  userId: string,
  firstMessageText: string,
): Promise<string> {
  const userPrompt = firstMessageText.slice(0, MAX_PROMPT_CHARS);
  const model = env.CHAT_MODEL ?? DEFAULT_LIGHT_LLM_MODEL;
  const resp = await generateLlmContent(env, {
    model,
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    systemInstruction: SYSTEM_INSTRUCTION,
  });
  // Logging is fire-and-forget — auto-title is non-critical and a missed
  // accounting row should never fail title generation. logWarn happens
  // implicitly inside Prisma if the insert fails.
  void logLlmCall({
    userId,
    source: "auto_title",
    model,
    inputTokens: resp.usageMetadata?.promptTokenCount ?? 0,
    ...(typeof resp.usageMetadata?.promptCacheHitTokenCount === "number"
      ? { inputCacheHitTokens: resp.usageMetadata.promptCacheHitTokenCount }
      : {}),
    ...(typeof resp.usageMetadata?.promptCacheMissTokenCount === "number"
      ? { inputCacheMissTokens: resp.usageMetadata.promptCacheMissTokenCount }
      : {}),
    outputTokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
    usdToCadRate: env.LLM_BUDGET_USD_TO_CAD_RATE,
  }).catch(() => {});
  return resp.text ?? "";
}
