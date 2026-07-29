import { logLlmCall } from "../llm/budget.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { Env as FinaEnv } from "../env.js";
import { monthlyEquivalent } from "../recurring/occurrences.js";
import { DEFAULT_PERIOD } from "../budget-plans/service.js";
import { DEFAULT_LIGHT_LLM_MODEL, generateLlmContent } from "../llm/provider.js";
import { effectiveExpenseAllocations } from "../transactions/cashflow.js";

/** One row in a generated savings plan. */
export type GoalStrategyItem = {
  /** Display name of the category to reduce / reroute. Free-text — the
   *  LLM names it, we don't enforce an FK so categories created later
   *  still work. */
  categoryName: string;
  /** Suggested monthly amount to redirect from this category, in CAD. */
  monthlyAmount: number;
  /** One-sentence justification. */
  rationale: string;
};

/** Persisted metadata for a goal's strategy. Per-row data (which
 *  categories, how much, rationale) lives in the GoalAllocation table.
 *  This JSON carries only the generator timestamp and an optional
 *  notice the UI can surface. */
export type GoalStrategyMeta = {
  generatedAt: string;
  /** When the LLM couldn't form a useful plan (no spend history etc.). */
  notice?: string;
};

const MODEL_DEFAULT = DEFAULT_LIGHT_LLM_MODEL;

const SYSTEM_PROMPT = `You are Fina, a thoughtful personal-finance coach.

You are given a user's savings goal and a per-category spending picture
broken into THREE numbers per category:
  - total: their actual average monthly spend (last 90 days)
  - committed: the portion that is recurring/fixed (rent, mortgage,
    subscriptions). This is OFF-LIMITS — you cannot cut it.
  - discretionary: total - committed. This is the ONLY portion you may
    propose cuts from.

Some categories also include a current monthly budget cap.

Your job: produce a concrete monthly savings plan listing which
categories to trim, by how much, and one short rationale each. The sum
of monthly_amount should land close to the required monthly pace.

Return STRICT JSON only — no markdown, no commentary — matching:
{
  "items": [
    { "categoryName": "Dining", "monthlyAmount": 80, "rationale": "You
       averaged $280/mo on dining — well above other discretionary
       categories. Cutting back here has the most headroom." }
  ]
}

Rationale style (very important):
- Explain WHY this category was picked. The user wants to understand
  the reasoning, not just the tactic. Lead with the observation:
  "You averaged $X/mo on Y" or "Y is your biggest discretionary
  bucket" or "Y has been creeping up vs last month".
- Always express figures in MONTHLY terms (e.g. "$80/mo"). Never
  weekly ($20/wk), daily, or annual.
- ≤ 140 chars, plain text, no emojis.

HARD rules:
- Never cut from a category whose discretionary is 0 (fully committed).
- Never propose monthlyAmount > 60% of that category's discretionary.
  Realistic cuts only — going to zero on dining is not realistic.
- Don't touch committed/recurring spend (rent, mortgage, subscriptions).
  Mention them in rationale only if relevant context.
- 2–5 items max. Pick categories with the largest discretionary room.
- If discretionary across all categories is too small to meet the pace,
  do your best and let the rationale acknowledge the gap.
- If the user has zero spending history, return { "items": [] }.
- Currency is CAD. Round monthlyAmount to whole dollars.`;

type CategoryAnalysis = {
  categoryName: string;
  /** Average monthly total spend across last 90 days. */
  totalMonthly: number;
  /** Portion that is locked-in recurring expense (subscriptions etc). */
  committedMonthly: number;
  /** total - committed, floored at 0. The cuttable budget. */
  discretionaryMonthly: number;
  /** Current default-budget cap for this category, if any. */
  budgetCap: number | null;
};

async function analyzeCategories(workspaceId: string): Promise<CategoryAnalysis[]> {
  const since = new Date(Date.now() - 90 * 86_400_000);
  // 1. 90-day spend grouped by category.
  const [allocations, recurring, defaultPlan] = await Promise.all([
    effectiveExpenseAllocations(workspaceId, {
      occurredAt: { gte: since },
    }),
    prisma.recurringExpense.findMany({
      where: { workspaceId, categoryId: { not: null } },
      select: {
        amount: true,
        cadence: true,
        categoryId: true,
        category: { select: { name: true } },
      },
    }),
    prisma.budgetPlan.findUnique({
      where: {
        workspaceId_periodStart: { workspaceId, periodStart: DEFAULT_PERIOD },
      },
      select: { categoryAllocations: true },
    }),
  ]);

  // Aggregate spend by category id (so different category-name displays
  // can't double-count) but key the output by name for the LLM.
  type Agg = { name: string; spend: number };
  const totals = new Map<string, Agg>();
  for (const r of allocations) {
    if (!r.categoryId || !r.categoryName) continue;
    const cur = totals.get(r.categoryId) ?? { name: r.categoryName, spend: 0 };
    cur.spend += r.amount;
    totals.set(r.categoryId, cur);
  }

  // Sum recurring monthlyEquivalents per category id.
  const committed = new Map<string, number>();
  for (const r of recurring) {
    if (!r.categoryId) continue;
    const m = monthlyEquivalent(Number(r.amount), r.cadence);
    committed.set(r.categoryId, (committed.get(r.categoryId) ?? 0) + m);
  }

  // Budget caps per category id from the default plan.
  const caps = new Map<string, number>();
  if (defaultPlan?.categoryAllocations) {
    const raw = defaultPlan.categoryAllocations;
    if (Array.isArray(raw)) {
      for (const a of raw as Array<{ categoryId?: unknown; amount?: unknown }>) {
        if (
          typeof a.categoryId === "string" &&
          typeof a.amount === "number" &&
          a.amount > 0
        ) {
          caps.set(a.categoryId, a.amount);
        }
      }
    }
  }

  // Build the final analysis array. Include categories that have either
  // spend or a recurring commitment — categories the user knows about.
  const allIds = new Set([...totals.keys(), ...committed.keys()]);
  const out: CategoryAnalysis[] = [];
  for (const id of allIds) {
    const t = totals.get(id);
    const name = t?.name ?? "Unknown";
    const totalMonthly = t ? Math.round((t.spend / 3) * 100) / 100 : 0;
    const committedMonthly =
      Math.round((committed.get(id) ?? 0) * 100) / 100;
    const discretionary = Math.max(0, totalMonthly - committedMonthly);
    out.push({
      categoryName: name,
      totalMonthly,
      committedMonthly,
      discretionaryMonthly: Math.round(discretionary * 100) / 100,
      budgetCap: caps.get(id) ?? null,
    });
  }
  // Sort by discretionary descending — most cuttable categories first.
  out.sort((a, b) => b.discretionaryMonthly - a.discretionaryMonthly);
  return out;
}

function buildPrompt(args: {
  goalTitle: string;
  target: number;
  saved: number;
  due: Date;
  monthsRemaining: number;
  categories: CategoryAnalysis[];
}): string {
  const lines: string[] = [];
  lines.push(`Goal: "${args.goalTitle}"`);
  lines.push(`Target: $${args.target.toFixed(2)} CAD`);
  lines.push(`Already saved: $${args.saved.toFixed(2)} CAD`);
  lines.push(`Due: ${args.due.toISOString().slice(0, 10)} (${args.monthsRemaining} months remaining)`);
  const requiredMonthly = Math.max(
    0,
    (args.target - args.saved) / Math.max(1, args.monthsRemaining),
  );
  lines.push(`Required monthly pace: $${requiredMonthly.toFixed(2)}/mo`);
  lines.push("");
  if (args.categories.length === 0) {
    lines.push("Spending history: none (user has no recent transactions).");
    return lines.join("\n");
  }
  lines.push("Per-category breakdown (last 90 days, monthly averages, CAD):");
  lines.push(
    "  format: <name> · total $X · committed $Y · discretionary $Z (cap $C)",
  );
  lines.push("  (committed = subscriptions/recurring; cap = current budget cap)");
  for (const c of args.categories.slice(0, 14)) {
    const cap = c.budgetCap !== null ? `$${c.budgetCap.toFixed(0)}` : "—";
    lines.push(
      `  - ${c.categoryName} · total $${c.totalMonthly.toFixed(0)} · ` +
        `committed $${c.committedMonthly.toFixed(0)} · ` +
        `discretionary $${c.discretionaryMonthly.toFixed(0)} (cap ${cap})`,
    );
  }
  const totalDiscretionary = args.categories.reduce(
    (s, c) => s + c.discretionaryMonthly,
    0,
  );
  lines.push("");
  lines.push(
    `Total cuttable discretionary across all categories: $${totalDiscretionary.toFixed(0)}/mo`,
  );
  if (totalDiscretionary < requiredMonthly) {
    lines.push(
      `WARNING: required pace exceeds total discretionary. Suggest the largest realistic cuts and note the shortfall in rationales.`,
    );
  }
  return lines.join("\n");
}

function stripCodeFences(s: string): string {
  // The LLM can still wrap JSON in ```json ... ``` despite the system prompt.
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function parseStrategy(text: string): GoalStrategyItem[] {
  try {
    const parsed = JSON.parse(stripCodeFences(text)) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { items?: unknown }).items)
    ) {
      return [];
    }
    const items = (parsed as { items: unknown[] }).items;
    const out: GoalStrategyItem[] = [];
    for (const raw of items) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const name = typeof r["categoryName"] === "string" ? r["categoryName"] : null;
      const amt = typeof r["monthlyAmount"] === "number" ? r["monthlyAmount"] : null;
      const why = typeof r["rationale"] === "string" ? r["rationale"] : null;
      if (!name || amt === null || amt < 0 || !why) continue;
      out.push({
        categoryName: name.trim().slice(0, 80),
        monthlyAmount: Math.round(amt),
        rationale: why.trim().slice(0, 240),
      });
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}

function monthsBetween(a: Date, b: Date): number {
  return Math.max(
    1,
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()),
  );
}

/** Adjust LLM-produced cut amounts so the sum matches the required
 *  monthly pace, while respecting per-category 60%-of-discretionary
 *  ceilings. LLMs often round each item to neat numbers and the sum
 *  ends up short by $3–$20; this closes that gap so 130/mo × 15mo
 *  actually equals the user's $2000 target. */
function normalizePlanToPace(
  items: GoalStrategyItem[],
  categories: CategoryAnalysis[],
  requiredPace: number,
): GoalStrategyItem[] {
  if (items.length === 0 || requiredPace <= 0) return items;
  const target = Math.round(requiredPace);
  const byName = new Map(
    categories.map((c) => [c.categoryName.toLowerCase(), c]),
  );
  const ceilings = items.map((i) => {
    const c = byName.get(i.categoryName.toLowerCase());
    return c ? Math.floor(c.discretionaryMonthly * 0.6) : i.monthlyAmount;
  });
  let amounts = items.map((i, idx) =>
    Math.min(i.monthlyAmount, ceilings[idx]!),
  );
  let sum = amounts.reduce((a, b) => a + b, 0);

  if (sum > target) {
    // Scale down proportionally.
    const ratio = target / sum;
    amounts = amounts.map((a) => Math.round(a * ratio));
  } else if (sum < target) {
    // Scale up proportionally to slack (ceiling - current), capped at
    // each item's ceiling. Any rounding remainder is distributed below.
    const slack = amounts.map((a, i) => ceilings[i]! - a);
    const totalSlack = slack.reduce((a, b) => a + b, 0);
    if (totalSlack > 0) {
      const fill = Math.min(target - sum, totalSlack);
      const ratio = fill / totalSlack;
      amounts = amounts.map((a, i) => a + Math.floor(slack[i]! * ratio));
    }
  }

  // Re-clamp to per-item ceilings + non-negative.
  amounts = amounts.map((a, i) => Math.max(0, Math.min(a, ceilings[i]!)));

  // Distribute any rounding-error remainder to the items with the most
  // slack so the final sum lands exactly on target (unless ceilings
  // simply don't allow it).
  let finalSum = amounts.reduce((a, b) => a + b, 0);
  if (finalSum < target) {
    let diff = target - finalSum;
    const order = amounts
      .map((a, i) => ({ idx: i, slack: ceilings[i]! - a }))
      .sort((x, y) => y.slack - x.slack);
    for (const o of order) {
      if (diff <= 0) break;
      const add = Math.min(diff, o.slack);
      amounts[o.idx] = (amounts[o.idx] ?? 0) + add;
      diff -= add;
    }
  } else if (finalSum > target) {
    let diff = finalSum - target;
    const order = amounts
      .map((a, i) => ({ idx: i, amt: a }))
      .sort((x, y) => y.amt - x.amt);
    for (const o of order) {
      if (diff <= 0) break;
      const cut = Math.min(diff, amounts[o.idx] ?? 0);
      amounts[o.idx] = (amounts[o.idx] ?? 0) - cut;
      diff -= cut;
    }
  }

  return items.map((it, idx) => ({
    ...it,
    monthlyAmount: amounts[idx] ?? it.monthlyAmount,
  }));
}

/** Generate + persist a strategy for the given goal. Failures are
 *  swallowed — the goal stays usable without a strategy, the UI will
 *  show "no plan yet" and the user can regenerate later. */
export async function generateAndStoreGoalStrategy(
  env: FinaEnv,
  goalId: string,
): Promise<void> {
  const goal = await prisma.goal.findUnique({ where: { id: goalId } });
  if (!goal) return;
  const target = Number(goal.targetAmount);
  const saved = Number(goal.savedAmount);
  const due = goal.dueDate;
  const months = monthsBetween(new Date(), due);
  const requiredMonthly = Math.max(0, (target - saved) / Math.max(1, months));
  const categories = await analyzeCategories(goal.workspaceId);
  const prompt = buildPrompt({
    goalTitle: goal.title,
    target,
    saved,
    due,
    monthsRemaining: months,
    categories,
  });

  let items: GoalStrategyItem[] = [];
  let notice: string | undefined;
  try {
    const model = env.CHAT_MODEL ?? MODEL_DEFAULT;
    const response = await generateLlmContent(env, {
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: 500,
      temperature: 0.4,
      responseMimeType: "application/json",
    });
    // Attribute spend to the workspace owner — same model as categorize.
    // Lookup is best-effort; missing ownership row (test fixture only)
    // simply skips accounting rather than throwing.
    const owner = await prisma.membership.findFirst({
      where: { workspaceId: goal.workspaceId, role: "owner" },
      select: { userId: true },
    });
    if (owner) {
      void logLlmCall({
        userId: owner.userId,
        source: "goal_strategy",
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
    const text = response.text ?? "";
    items = parseStrategy(text);
    if (items.length === 0 && categories.length === 0) {
      notice =
        "Connect a bank or log a few transactions and I'll suggest where to cut back.";
    } else if (items.length === 0) {
      const totalDiscretionary = categories.reduce(
        (s, c) => s + c.discretionaryMonthly,
        0,
      );
      notice =
        totalDiscretionary < 50
          ? "Most of your spend is locked into rent, mortgage, or subscriptions. There's little discretionary room to cut. Consider extending the deadline or trimming a recurring subscription."
          : "Couldn't form a useful plan from this history. Try regenerating later.";
    } else {
      // Post-validate: clamp each item's monthlyAmount to 60% of the
      // category's discretionary so the LLM can't accidentally exceed
      // our HARD rule. Matches by case-insensitive name; if no match,
      // we leave the item as-is (LLM may have invented a category we
      // don't track yet).
      const byName = new Map(
        categories.map((c) => [c.categoryName.toLowerCase(), c]),
      );
      items = items.map((item) => {
        const c = byName.get(item.categoryName.toLowerCase());
        if (!c) return item;
        const ceiling = Math.floor(c.discretionaryMonthly * 0.6);
        if (item.monthlyAmount > ceiling) {
          return { ...item, monthlyAmount: Math.max(0, ceiling) };
        }
        return item;
      });
      // Then nudge the sum toward the required monthly pace so
      // amount × monthsRemaining actually closes the goal gap — the
      // LLM frequently rounds to neat numbers and lands a few dollars
      // short. Per-item ceilings still bound everything.
      items = normalizePlanToPace(items, categories, requiredMonthly);
    }
  } catch {
    // Generation failed — store an empty strategy with a notice so the
    // UI can show something useful instead of looping in a loading state.
    notice = "Couldn't generate a plan right now. Try regenerating later.";
  }

  // Resolve LLM's free-text category names to real category IDs so we
  // can persist proper FK-backed allocations (no more JSON name matching
  // at read time). Items whose name doesn't match a known category in
  // this workspace are kept in the JSON only for debug visibility but
  // do NOT become allocations — they wouldn't earn savings anyway.
  const cats = await prisma.category.findMany({
    where: { workspaceId: goal.workspaceId, archivedAt: null },
    select: { id: true, name: true },
  });
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
  type ResolvedItem = GoalStrategyItem & { categoryId: string };
  const resolvedItems: ResolvedItem[] = [];
  for (const it of items) {
    const id = catByName.get(it.categoryName.toLowerCase());
    if (id) resolvedItems.push({ ...it, categoryId: id });
  }

  // Strategy JSON now only carries generator metadata. Per-row data
  // lives in GoalAllocation.
  const strategy = {
    generatedAt: new Date().toISOString(),
    ...(notice ? { notice } : {}),
  };
  await prisma.$transaction(async (tx) => {
    await tx.goal.update({
      where: { id: goalId },
      data: { strategy: strategy as unknown as Prisma.InputJsonValue },
    });
    await tx.goalAllocation.deleteMany({ where: { goalId } });
    if (resolvedItems.length > 0) {
      await tx.goalAllocation.createMany({
        data: resolvedItems.map((r) => ({
          goalId,
          categoryId: r.categoryId,
          monthlyAmount: new Prisma.Decimal(r.monthlyAmount),
          rationale: r.rationale,
        })),
      });
    }
  });
}
