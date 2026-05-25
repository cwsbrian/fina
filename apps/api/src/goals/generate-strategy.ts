import { GoogleGenAI } from "@google/genai";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { FinaEnv } from "../env.js";
import { monthlyEquivalent } from "../recurring/occurrences.js";
import { DEFAULT_PERIOD } from "../budget-plans/service.js";

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

export type GoalStrategy = {
  items: GoalStrategyItem[];
  generatedAt: string;
  /** When the LLM couldn't form a useful plan (no spend history etc.). */
  notice?: string;
};

const MODEL_DEFAULT = "gemini-2.5-flash-lite";

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
    { "categoryName": "Dining", "monthlyAmount": 80, "rationale": "Trim
       dining by ~$20/wk — small swaps add up." }
  ]
}

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
- Currency is CAD. Round monthlyAmount to whole dollars.
- Rationale: ≤ 100 chars, plain text, no emojis.`;

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
    prisma.transactionAllocation.findMany({
      where: {
        amount: { gt: 0 },
        transaction: {
          workspaceId,
          removedAt: null,
          occurredAt: { gte: since },
          amount: { gt: 0 },
        },
        categoryId: { not: null },
      },
      select: {
        amount: true,
        categoryId: true,
        category: { select: { name: true } },
      },
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
    if (!r.categoryId || !r.category) continue;
    const cur = totals.get(r.categoryId) ?? { name: r.category.name, spend: 0 };
    cur.spend += Number(r.amount);
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
  // Gemini occasionally wraps JSON in ```json ... ``` despite the system prompt.
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
        rationale: why.trim().slice(0, 200),
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
    const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
    const model = env.CHAT_MODEL ?? MODEL_DEFAULT;
    const response = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: 500,
        temperature: 0.4,
        responseMimeType: "application/json",
      },
    });
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
          ? "Most of your spend is locked into rent, mortgage, or subscriptions — there's little discretionary room to cut. Consider extending the deadline or trimming a recurring subscription."
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
    }
  } catch {
    // Generation failed — store an empty strategy with a notice so the
    // UI can show something useful instead of looping in a loading state.
    notice = "Couldn't generate a plan right now. Try regenerating later.";
  }

  const strategy: GoalStrategy = {
    items,
    generatedAt: new Date().toISOString(),
    ...(notice ? { notice } : {}),
  };
  await prisma.goal.update({
    where: { id: goalId },
    data: { strategy: strategy as unknown as Prisma.InputJsonValue },
  });
}
