import { estimateMessageTokens } from "./token-estimate.js";

export type HistoryCandidate = {
  id: string;
  blocks: unknown;
  createdAt: Date;
};

export type WindowOptions = {
  limitMessages: number;
  budgetTokens: number;
};

/**
 * Pick a chronological slice of recent chat messages to send to the LLM.
 *
 * Input `newestFirst` is ordered from newest to oldest (matching Prisma's
 * `orderBy: { createdAt: "desc" }` shape). The returned slice is chronological
 * (oldest → newest) and bounded by both `limitMessages` (count cap) and
 * `budgetTokens` (rough JSON-length heuristic). Whichever cap hits first wins.
 *
 * If the newest single message alone exceeds the budget, it is still returned
 * (cutting it would leave an empty history, which the LLM can't act on).
 */
export function selectHistoryWindow<T extends HistoryCandidate>(
  newestFirst: T[],
  opts: WindowOptions,
): T[] {
  const capped = newestFirst.slice(0, opts.limitMessages);
  const selected: T[] = [];
  let used = 0;
  for (const msg of capped) {
    const cost = estimateMessageTokens(msg.blocks);
    if (selected.length > 0 && used + cost > opts.budgetTokens) break;
    selected.push(msg);
    used += cost;
  }
  return selected.reverse();
}
