import { GoogleGenAI } from "@google/genai";
import type { BriefContext, BriefType } from "./brief-context.js";
import type { PresentationBlock } from "./blocks.js";
import type { Env } from "../env.js";
import { logLlmCall } from "../llm/budget.js";

const SYSTEM_PROMPT_PER_TYPE: Record<BriefType, string> = {
  daily: `너는 Fina라는 가계부 AI 비서야. 매일 아침 사용자에게 한 메시지 brief를 줘.
사용자의 모든 workspace를 본 종합 brief를 한국어로 간결하게 (3~5문장) 작성해.
- 어제 활동 + 오늘 예정 + 이번주 budget 페이스를 적절히 섞어.
- 새 transaction이 없거나 별 일 없으면 격려/응원 메시지로 마무리해 ("좋은 하루 보내" 같은).
- 마크다운 사용 가능. 카테고리 분류가 필요한 거래가 있으면 한 줄로 짚어줘.
- 어조는 친근하고 다정하게. 매일 똑같은 표현은 피해.`,
  weekly: `너는 Fina야. 매주 월요일 아침 사용자에게 weekly brief를 줘.
지난주 종합 + 이번주 schedule + 이번달 budget을 5~7문장으로 한국어로 작성.
"한 주가 시작됐어" 같은 톤. 격려도 자연스럽게.`,
  monthly: `너는 Fina야. 매월 1일 아침 사용자에게 monthly brief를 줘.
지난달 종합 + 이번달 schedule + 다음 30일 recurring을 6~8문장으로 한국어로 작성.
"새 달이야" 같은 톤. 페이스 deviation이 있으면 가볍게 언급. 격려 잊지 마.`,
};

/** Build the user-message JSON we feed Gemini. The financial state goes
 *  into the user role so it doesn't bloat the cached system message. */
function buildUserMessage(context: BriefContext, recentBriefTexts: string[]): string {
  return JSON.stringify({
    today: context.date,
    user: context.user,
    workspaces: context.workspaces,
    recent_briefs: recentBriefTexts,
    instruction: "위 context를 보고 brief를 markdown text로만 작성해. presentation block은 text 한 개만 emit해.",
  }, null, 2);
}

export async function generateBrief(
  env: Env,
  context: BriefContext,
  recentBriefTexts: string[],
  briefType: BriefType,
): Promise<PresentationBlock[]> {
  const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const model = env.CHAT_MODEL ?? "gemini-2.5-flash-lite";

  const response = await client.models.generateContent({
    model,
    contents: [
      { role: "user", parts: [{ text: buildUserMessage(context, recentBriefTexts) }] },
    ],
    config: {
      systemInstruction: SYSTEM_PROMPT_PER_TYPE[briefType],
      // No tools — brief is emit-only. (Omit the key entirely; the Gemini
      // GenerateContentConfig type doesn't accept `undefined` under
      // exactOptionalPropertyTypes.)
      maxOutputTokens: 800,
      temperature: 0.7,
    },
  });

  // Brief is system-initiated — runs even if the user has hit their weekly
  // LLM budget cap. But the cost still counts against next week's window.
  void logLlmCall({
    userId: context.user.id,
    source: "brief",
    model,
    inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
  }).catch(() => {});

  const text = response.text;
  if (!text || text.trim().length === 0) {
    // Fallback — never emit empty brief. Always encouragement.
    return [{ type: "text", markdown: "좋은 아침이야 ☀️ 오늘도 잘 보내!" }];
  }

  return [{ type: "text", markdown: text.trim() }];
}

/** Extract the markdown text from past briefs' PresentationBlock[] JSON
 *  for anti-repetition injection. Spec §8: skip confirm_card; concat text
 *  block markdown with \n; truncate to 1000 chars per brief. */
export function briefBlocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const texts: string[] = [];
  for (const b of blocks) {
    if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
      const md = (b as { markdown?: string }).markdown;
      if (typeof md === "string") texts.push(md);
    }
  }
  const joined = texts.join("\n");
  return joined.length > 1000 ? joined.slice(0, 1000) : joined;
}
