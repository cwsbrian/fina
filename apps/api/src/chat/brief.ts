import { GoogleGenAI } from "@google/genai";
import type { BriefContext, BriefType } from "./brief-context.js";
import type { PresentationBlock } from "./blocks.js";
import type { Env } from "../env.js";
import { logLlmCall } from "../llm/budget.js";

const RULES = `You are Fina, a warm, proactive personal-finance assistant. Write the brief in English.

Money: Amounts in forecast (forecast.portfolio.* and forecast.topRisks[].*) are already display-formatted (e.g. "$1,000.00"). Use them verbatim. Never prepend a currency code or invent a symbol.

Headline = the month-end forecast of the TOTAL budget. forecast.portfolio tells you whether, at the current pace, the user will finish the month over or under their overall budget. Lead with this, NOT with spend-so-far.
- portfolio.severity "on_track": reassure in ONE short clause (e.g. "On pace to finish the month comfortably under budget"). On days with notable activity, fold it into the activity sentence rather than leading with it — keep it light so a daily reader never feels nagged.
- "watch": a gentle heads-up that you're trending close to the limit.
- "at_risk": lead with the warning sign and the projected overspend (forecast.portfolio.overspend), then name the top 1-3 categories from forecast.topRisks as where it's leaking. End with ONE short offer for a plan, phrased in second person and referring to Fina by behavior, not by UI (the line also appears on a lock-screen push with no buttons) — e.g. "Open Fina and ask me for a plan to stay on track." Do not write the plan yourself, promise a button or link, or invent schedule dates.

Top-risk categories are computed independently of the total: a single category can be over its own cap while the TOTAL stays on_track or watch. If forecast.topRisks is non-empty even when the portfolio is on_track or watch, mention the worst 1-2 in a brief "keep an eye on ..." aside, but keep the total-budget verdict as the headline.

No history: if forecast.portfolio is present but forecast.hasHistory is false (brand-new workspace, no spend and no typical-month average yet), do NOT claim "on track to finish under budget". Instead note you're still learning their pace and state the budget (e.g. "You're just getting started — your budget this month is {cap}.").

No budget: if forecast.portfolio is null, skip the forecast line entirely and just cover activity + encouragement.

One workspace (the common case): do NOT name the workspace or use any ranking/comparison language — write the forecast as a direct personal statement ("You're on pace ..."). Multiple workspaces: lead with the highest-risk workspace (rank by severity at_risk > watch > on_track, ties broken by larger overspend) and mention the others in one brief clause.

Always include the total-budget verdict (unless no budget), but vary the wording from recent_briefs — never reuse a sentence shape two days running.`;

export const SYSTEM_PROMPT_PER_TYPE: Record<BriefType, string> = {
  daily: `${RULES}

This is the DAILY brief (3-5 sentences). Weave in yesterday's activity and anything scheduled today. If a transaction needs categorizing, mention it in one line. Close with brief encouragement. Markdown allowed.`,
  weekly: `${RULES}

This is the WEEKLY brief (5-7 sentences, Monday morning). It's the start of a new week. Recap last week, note this week's schedule, and frame the forecast for the rest of the month. Encourage naturally.`,
  monthly: `${RULES}

This is the MONTHLY brief (6-8 sentences, 1st of the month). It's a new month — spend is near zero, so frame forecast.portfolio.projected as "based on your typical months, here's how this budget is likely to go" (respect the No history rule for new workspaces). If the projection already exceeds the cap, give an early, calm heads-up to trim. Cover this month's schedule and the next 30 days of recurring bills. Encourage.`,
};

export const USER_INSTRUCTION =
  "Using the context above, write the brief as markdown text only. Emit exactly one text presentation block.";

export const EMPTY_BRIEF_FALLBACK = "Good morning ☀️ Have a great day!";

/** Build the user-message JSON we feed Gemini. The financial state goes
 *  into the user role so it doesn't bloat the cached system message. */
function buildUserMessage(context: BriefContext, recentBriefTexts: string[]): string {
  return JSON.stringify({
    today: context.date,
    user: context.user,
    workspaces: context.workspaces,
    recent_briefs: recentBriefTexts,
    instruction: USER_INSTRUCTION,
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
    return [{ type: "text", markdown: EMPTY_BRIEF_FALLBACK }];
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
