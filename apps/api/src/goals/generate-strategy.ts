import { GoogleGenAI } from "@google/genai";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import type { FinaEnv } from "../env.js";

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

Given a user's savings goal (title, target amount, due date) and their
average monthly spending by category, suggest a concrete monthly savings
plan: which categories to trim or reroute, by how much, and a one-line
rationale per item. Sum of recommended monthly_amount should be close to
the required monthly pace (target / months remaining minus current saved).

Return STRICT JSON only — no markdown, no commentary — matching:
{
  "items": [
    { "categoryName": "Dining", "monthlyAmount": 80, "rationale": "Trim
       dining by ~$20/wk — small swaps add up." }
  ]
}

Rules:
- 2–5 items max. Pick categories with the highest realistic savings room.
- Don't suggest negative amounts.
- If the user has zero spending history, return { "items": [] }.
- Currency is CAD. Round monthlyAmount to whole dollars.
- Rationale: ≤ 100 chars, no emojis, plain text.`;

type SpendByCategory = { categoryName: string; monthlyAvgCAD: number };

async function recentMonthlySpend(workspaceId: string): Promise<SpendByCategory[]> {
  // Last 90 days of expense allocations (positive amount), grouped by
  // category. Divide total by 3 to get monthly average.
  const since = new Date(Date.now() - 90 * 86400_000);
  const rows = await prisma.transactionAllocation.findMany({
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
      category: { select: { name: true } },
    },
  });
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (!r.category) continue;
    const cur = totals.get(r.category.name) ?? 0;
    totals.set(r.category.name, cur + Number(r.amount));
  }
  return Array.from(totals, ([categoryName, total]) => ({
    categoryName,
    monthlyAvgCAD: Math.round((total / 3) * 100) / 100,
  })).sort((a, b) => b.monthlyAvgCAD - a.monthlyAvgCAD);
}

function buildPrompt(args: {
  goalTitle: string;
  target: number;
  saved: number;
  due: Date;
  monthsRemaining: number;
  spend: SpendByCategory[];
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
  if (args.spend.length === 0) {
    lines.push("Spending history: none (user has no recent transactions).");
  } else {
    lines.push("Average monthly spending by category (last 90 days):");
    for (const s of args.spend.slice(0, 12)) {
      lines.push(`  - ${s.categoryName}: $${s.monthlyAvgCAD.toFixed(2)}/mo`);
    }
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
  const spend = await recentMonthlySpend(goal.workspaceId);
  const prompt = buildPrompt({
    goalTitle: goal.title,
    target,
    saved,
    due,
    monthsRemaining: months,
    spend,
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
    if (items.length === 0 && spend.length === 0) {
      notice =
        "Connect a bank or log a few transactions and I'll suggest where to cut back.";
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
