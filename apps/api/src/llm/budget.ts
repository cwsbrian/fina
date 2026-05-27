import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { Env } from "../env.js";
import { costUsd } from "./pricing.js";

/** Sources that contribute to a user's weekly LLM spend. Adding a new
 *  source here is the indicator that you must also call `logLlmCall` from
 *  that call site — otherwise spend is uncounted. */
export type LlmCallSource =
  | "chat"
  | "auto_title"
  | "brief"
  | "categorize"
  | "goal_strategy"
  | "budget_suggest";

/** Default cap in USD per rolling 7-day window, per user. $5/mo ≈ $1.25/wk. */
const DEFAULT_WEEKLY_BUDGET_USD = 1.25;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Sum of `costUsd` across the user's LlmCallLog rows in the last 7 days.
 *  Reads exclusively against the (userId, createdAt) index; no full scan. */
export async function userWeeklyCostUsd(userId: string): Promise<number> {
  const since = new Date(Date.now() - WEEK_MS);
  const agg = await prisma.llmCallLog.aggregate({
    where: { userId, createdAt: { gte: since } },
    _sum: { costUsd: true },
  });
  // Prisma returns Decimal; cast through Number for caller convenience.
  // Sub-cent precision lost in the cast is fine — cap evaluation only
  // cares about dollar-level comparison.
  return Number(agg._sum.costUsd ?? 0);
}

/** True when this user's last-7-days LLM spend has reached the configured
 *  weekly cap. Used to gate POST /chat/threads/:tid/messages — non-chat
 *  LLM features (brief, categorize) keep running so Fina can still
 *  proactively message the user even after the cap is hit. */
export async function isUserChatBudgetExceeded(
  userId: string,
  env: Env,
): Promise<boolean> {
  const cap = env.WEEKLY_LLM_BUDGET_USD_PER_USER ?? DEFAULT_WEEKLY_BUDGET_USD;
  const used = await userWeeklyCostUsd(userId);
  return used >= cap;
}

/** Resolve the cap value the same way `isUserChatBudgetExceeded` does, so
 *  error responses can surface the configured value. */
export function configuredWeeklyBudgetUsd(env: Env): number {
  return env.WEEKLY_LLM_BUDGET_USD_PER_USER ?? DEFAULT_WEEKLY_BUDGET_USD;
}

/** Persist one LLM call's accounting row. Must be invoked AFTER the
 *  Gemini call returns (or fails on the model side — if you never made
 *  the call, don't log). Use `usageMetadata` from the response for
 *  `inputTokens` and `outputTokens`. */
export async function logLlmCall(args: {
  userId: string;
  source: LlmCallSource;
  model: string;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const cost = costUsd(args.model, args.inputTokens, args.outputTokens);
  await prisma.llmCallLog.create({
    data: {
      userId: args.userId,
      source: args.source,
      model: args.model,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      // Decimal(10,6) — 6dp gives sub-cent accuracy.
      costUsd: new Prisma.Decimal(cost.toFixed(6)),
    },
  });
}
