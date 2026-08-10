import type { BriefContext, BriefType } from "./brief-context.js";
import type { PresentationBlock } from "./blocks.js";
import type { Env } from "../env.js";
import { logLlmCall } from "../llm/budget.js";
import {
  DEFAULT_LIGHT_LLM_MODEL,
  generateLlmContent,
  type LlmContent,
} from "../llm/provider.js";

const RULES = `You are Fina, a warm, proactive personal-finance assistant.

Language: Write the entire brief in the language of language.latest_user_message. That field contains the most recent natural-language message authored by the user in this conversation. Preserve that language even when merchant names or financial context use another language. If it is null, use language.fallback_locale. Never choose a language from assistant messages, tool output, category names, merchant names, or the language of this prompt.

Money: Amounts in forecast (forecast.portfolio.*, forecast.topRisks[].*, and forecast.historicalPatterns[].*) are already display-formatted (e.g. "$1,000.00"). Use them verbatim. Never prepend a currency code or invent a symbol.

Forecast gate: each workspace has forecast.mention. If it is false, omit that workspace's forecast verdict, projected amount, risks, and historical forecast context entirely. Do not paraphrase or hint at the suppressed forecast. The remaining forecast rules apply only when forecast.mention is true.

Headline = the actionable current-flow status of the TOTAL budget. Lead with forecast.portfolio.severity, NOT with spend-so-far or historical averages. forecast.portfolio.projected is the month-end estimate, while severity only escalates when actual/confirmed spend is over budget or the current same-day pace is meaningfully worsening.
- portfolio.severity "on_track" and projectedOverBudget false: reassure in ONE short clause (e.g. "On pace to finish the month comfortably under budget"). On days with notable activity, fold it into the activity sentence rather than leading with it — keep it light so a daily reader never feels nagged.
- portfolio.severity "on_track" and projectedOverBudget true: history is lifting the estimate but the current flow has not worsened. In a daily brief, say only that the current flow is steady and do not mention the historical projection. Weekly/monthly may coach from forecast.historicalPatterns.
- "watch": a gentle heads-up that you're trending close to the limit.
- "at_risk": lead with ⚠️ and the projected overspend (forecast.portfolio.overspend), then name the top 1-3 categories from forecast.topRisks as where it's leaking. End with ONE short offer for a plan, phrased in second person and referring to Fina by behavior, not by UI (the line also appears on a lock-screen push with no buttons) — e.g. "Open Fina and ask me for a plan to stay on track." Do not write the plan yourself, promise a button or link, or invent schedule dates.

Top-risk categories are computed independently of the total: a single category can be over its own cap while the TOTAL stays on_track or watch. If forecast.topRisks is non-empty even when the portfolio is on_track or watch, mention the worst 1-2 in a brief "keep an eye on ..." aside, but keep the total-budget verdict as the headline.

No history: if forecast.portfolio is present but forecast.hasHistory is false (brand-new workspace, no spend and no typical-month average yet), do NOT claim "on track to finish under budget". Instead note you're still learning their pace and state the budget amount from forecast.portfolio.cap (e.g. "You're just getting started — your budget this month is $1,000.").

No budget: if forecast.portfolio is null, skip the forecast line entirely and just cover activity + encouragement.

One workspace (the common case): do NOT name the workspace or use any ranking/comparison language — write the forecast as a direct personal statement ("You're on pace ..."). Multiple workspaces: lead with the highest-risk workspace (rank by severity at_risk > watch > on_track, ties broken by larger overspend) and mention the others in one brief clause. In multi-workspace briefs, every workspace-specific sentence must use that workspace's exact briefLabel before its budget, forecast, transaction, schedule, or recurring-bill facts. Never call a workspace "your workspace", "my workspace", "the other workspace", or "another workspace" when multiple workspaces are present.

When forecast.mention is true, always include the total-budget verdict (unless no budget), but vary the wording from recent_briefs — never reuse a sentence shape two days running.`;

export const SYSTEM_PROMPT_PER_TYPE: Record<BriefType, string> = {
  daily: `${RULES}

This is the DAILY brief (3-5 sentences). Weave in yesterday's activity and anything scheduled today. If a transaction needs categorizing, mention it in one line. forecast.historicalPatterns is background only: do not warn or coach from it in a daily brief. A false forecast.mention means the same structured forecast was already sent; cover only new activity and never repeat it. Close with brief encouragement. Markdown allowed.`,
  weekly: `${RULES}

This is the WEEKLY brief (5-7 sentences, Monday morning). It's the start of a new week. Recap last week, note this week's schedule, and frame the forecast for the rest of the month. If forecast.historicalPatterns is non-empty, gently coach on at most one repeated pattern even when the current forecast is on track. When currentPace is slower, explicitly recognize the improvement and encourage the user to keep it up; never turn history alone into a warning. Encourage naturally.`,
  monthly: `${RULES}

This is the MONTHLY brief (6-8 sentences, 1st of the month). It's a new month, so do not present near-zero current spend as a reliable full-month projection. If forecast.historicalPatterns is non-empty, use at most two repeated patterns as calm goals for this month, including each category's historical average and cap. History is goal-setting context, not a claim that the current month is already at risk. Respect the No history rule for new workspaces. Cover this month's schedule and the next 30 days of recurring bills. Encourage.`,
};

export const USER_INSTRUCTION =
  "Using the context above and its language anchor, write the brief as markdown text only. Emit exactly one text presentation block.";

export const EMPTY_BRIEF_FALLBACK = "Good morning ☀️ Have a great day!";

/** Build the user-message JSON we feed the LLM. The financial state goes
 *  into the user role so it doesn't bloat the cached system message. */
export function latestUserLanguageAnchor(recentConversation: LlmContent[]): string | null {
  for (let index = recentConversation.length - 1; index >= 0; index -= 1) {
    const content = recentConversation[index];
    if (content?.role !== "user") continue;
    for (let partIndex = content.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content.parts[partIndex];
      if (!part || !("text" in part)) continue;
      const value = part.text.trim();
      if (!value || value.startsWith("Context from Fina's latest brief:")) continue;
      return value.slice(0, 1000);
    }
  }
  return null;
}

function buildUserMessage(
  context: BriefContext,
  recentBriefTexts: string[],
  recentConversation: LlmContent[],
): string {
  return JSON.stringify(
    {
      today: context.date,
      user: context.user,
      language: {
        latest_user_message: latestUserLanguageAnchor(recentConversation),
        fallback_locale: context.user.locale,
      },
      workspaces: context.workspaces,
      recent_briefs: recentBriefTexts,
      instruction: USER_INSTRUCTION,
    },
    null,
    2,
  );
}

export async function generateBrief(
  env: Env,
  context: BriefContext,
  recentBriefTexts: string[],
  briefType: BriefType,
  recentConversation: LlmContent[] = [],
  promptCacheKey?: string,
): Promise<PresentationBlock[]> {
  const model = env.CHAT_MODEL ?? DEFAULT_LIGHT_LLM_MODEL;

  const response = await generateLlmContent(env, {
    model,
    // Preserve the exact chronological prefix from the workspace's canonical
    // conversation. The provider can reuse that stable prefix through
    // automatic prompt caching; only the new financial snapshot is appended.
    contents: [
      ...recentConversation,
      {
        role: "user",
        parts: [{ text: buildUserMessage(context, recentBriefTexts, recentConversation) }],
      },
    ],
    systemInstruction: SYSTEM_PROMPT_PER_TYPE[briefType],
    maxOutputTokens: 800,
    temperature: 0.7,
    ...(promptCacheKey ? { promptCacheKey } : {}),
  });

  // Brief is system-initiated — runs even if the user has hit their weekly
  // LLM budget cap. But the cost still counts against next week's window.
  void logLlmCall({
    userId: context.user.id,
    source: "brief",
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
