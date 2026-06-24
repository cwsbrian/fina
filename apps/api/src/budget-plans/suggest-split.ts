import { logLlmCall } from "../llm/budget.js";
import { prisma } from "../db.js";
import type { Env as FinaEnv } from "../env.js";
import { DEFAULT_LIGHT_LLM_MODEL, generateLlmContent } from "../llm/provider.js";
import { budgetExpenseAllocationWhere } from "../transactions/budget-impact.js";

export type SuggestedAllocation = {
  categoryId: string;
  categoryName: string;
  amount: number;
};

export type SuggestResult = {
  allocations: SuggestedAllocation[];
  notice?: string;
};

const MODEL_DEFAULT = DEFAULT_LIGHT_LLM_MODEL;

const SYSTEM_PROMPT = `You are Fina, a personal-finance coach.

Given a user's monthly TOTAL budget and their average monthly spending
by category (last 90 days), propose a per-category allocation that
sums to (approximately) the total budget. Use realistic numbers based
on the recent spending — don't propose zero for a category they
actively use, and don't propose unrealistic increases.

Return STRICT JSON only — no markdown, no commentary — matching:
{
  "allocations": [
    { "categoryName": "Groceries", "amount": 400 },
    { "categoryName": "Dining", "amount": 200 }
  ]
}

Rules:
- Include a row for each category the user currently spends on.
- Round amounts to whole dollars.
- Sum should be close to (within 5%) the total budget. If recent
  spend exceeds the total budget you propose lower amounts that
  hit the cap.
- If the user has zero spend history return { "allocations": [] }.`;

type SpendByCategory = {
  categoryId: string;
  categoryName: string;
  monthlyAvgCAD: number;
};

async function recentMonthlySpend(
  workspaceId: string,
): Promise<{ spend: SpendByCategory[]; monthCount: number }> {
  const since = new Date(Date.now() - 90 * 86400_000);
  const rows = await prisma.transactionAllocation.findMany({
    where: {
      ...budgetExpenseAllocationWhere({
        workspaceId,
        occurredAt: { gte: since },
      }),
      categoryId: { not: null },
    },
    select: {
      amount: true,
      categoryId: true,
      category: { select: { name: true } },
      transaction: { select: { occurredAt: true } },
    },
  });
  const totals = new Map<
    string,
    { name: string; total: number }
  >();
  const months = new Set<string>();
  for (const r of rows) {
    if (!r.categoryId || !r.category) continue;
    months.add(r.transaction.occurredAt.toISOString().slice(0, 7));
    const cur = totals.get(r.categoryId) ?? { name: r.category.name, total: 0 };
    cur.total += Number(r.amount);
    totals.set(r.categoryId, cur);
  }
  return {
    monthCount: months.size,
    spend: Array.from(totals, ([categoryId, v]) => ({
      categoryId,
      categoryName: v.name,
      monthlyAvgCAD: Math.round((v.total / 3) * 100) / 100,
    })).sort((a, b) => b.monthlyAvgCAD - a.monthlyAvgCAD),
  };
}

function stripCodeFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

function parseAllocations(
  text: string,
  byName: Map<string, string>,
): SuggestedAllocation[] {
  try {
    const parsed = JSON.parse(stripCodeFences(text)) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { allocations?: unknown }).allocations)
    ) {
      return [];
    }
    const items = (parsed as { allocations: unknown[] }).allocations;
    const out: SuggestedAllocation[] = [];
    for (const raw of items) {
      if (typeof raw !== "object" || raw === null) continue;
      const r = raw as Record<string, unknown>;
      const name = typeof r["categoryName"] === "string" ? r["categoryName"] : null;
      const amt = typeof r["amount"] === "number" ? r["amount"] : null;
      if (!name || amt === null || amt < 0) continue;
      const id = byName.get(name.toLowerCase());
      if (!id) continue;
      // Keep the raw (non-integer) amount through normalization so the
      // proportional scaling later doesn't compound rounding error.
      out.push({
        categoryId: id,
        categoryName: name,
        amount: amt,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Scale LLM-produced amounts proportionally so they sum to exactly
 *  `totalAmount` in whole dollars. The LLM tends to come close but
 *  rarely lands on the exact total; do the math ourselves. */
function normalizeToTotal(
  allocations: SuggestedAllocation[],
  totalAmount: number,
): SuggestedAllocation[] {
  if (allocations.length === 0) return allocations;
  const rawSum = allocations.reduce((s, a) => s + a.amount, 0);
  if (rawSum <= 0) return allocations;
  // Scale proportionally.
  const scaled = allocations.map((a) => ({
    ...a,
    raw: (a.amount / rawSum) * totalAmount,
  }));
  // Floor each to int, distribute the remainder dollar-by-dollar to the
  // categories with the largest fractional remainder (banker-friendly,
  // sum exactly matches the input total).
  const totalInt = Math.round(totalAmount);
  const floored = scaled.map((s) => ({
    categoryId: s.categoryId,
    categoryName: s.categoryName,
    amount: Math.floor(s.raw),
    frac: s.raw - Math.floor(s.raw),
  }));
  let deficit = totalInt - floored.reduce((s, f) => s + f.amount, 0);
  // Largest fractional remainder gets the next +1 until deficit hits 0.
  // (deficit can be negative if totalInt < sum-of-floors; symmetric case.)
  if (deficit !== 0) {
    const ordered = floored
      .slice()
      .sort((a, b) =>
        deficit > 0 ? b.frac - a.frac : a.frac - b.frac,
      );
    for (let i = 0; i < ordered.length && deficit !== 0; i++) {
      const o = ordered[i];
      if (!o) break;
      if (deficit > 0) {
        o.amount += 1;
        deficit -= 1;
      } else {
        if (o.amount > 0) {
          o.amount -= 1;
          deficit += 1;
        }
      }
    }
  }
  return floored.map((f) => ({
    categoryId: f.categoryId,
    categoryName: f.categoryName,
    amount: f.amount,
  }));
}

export async function suggestBudgetSplit(
  env: FinaEnv,
  workspaceId: string,
  totalAmount: number,
): Promise<SuggestResult> {
  const { spend, monthCount } = await recentMonthlySpend(workspaceId);
  if (spend.length === 0) {
    return {
      allocations: [],
      notice:
        "Connect a bank or log a few transactions first so I have something to split against.",
    };
  }
  if (monthCount < 3) {
    return {
      allocations: [],
      notice:
        "Fina needs about three months of categorized spending history before it can suggest a reliable split.",
    };
  }

  const lines: string[] = [];
  lines.push(`Total monthly budget: $${totalAmount.toFixed(2)} CAD`);
  lines.push("");
  lines.push("Average monthly spending by category (last 90 days):");
  for (const s of spend) {
    lines.push(`  - ${s.categoryName}: $${s.monthlyAvgCAD.toFixed(2)}/mo`);
  }

  const byName = new Map<string, string>(
    spend.map((s) => [s.categoryName.toLowerCase(), s.categoryId]),
  );

  try {
    const model = env.CHAT_MODEL ?? MODEL_DEFAULT;
    const response = await generateLlmContent(env, {
      model,
      contents: [{ role: "user", parts: [{ text: lines.join("\n") }] }],
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: 500,
      temperature: 0.3,
      responseMimeType: "application/json",
    });
    const owner = await prisma.membership.findFirst({
      where: { workspaceId, role: "owner" },
      select: { userId: true },
    });
    if (owner) {
      void logLlmCall({
        userId: owner.userId,
        source: "budget_suggest",
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
    const raw = parseAllocations(text, byName);
    if (raw.length === 0) {
      return {
        allocations: [],
        notice:
          "Fina couldn't suggest a split right now. Try entering category amounts manually.",
      };
    }
    return { allocations: normalizeToTotal(raw, totalAmount) };
  } catch {
    return {
      allocations: [],
      notice:
        "Couldn't reach Fina's plan model. Try entering category amounts manually.",
    };
  }
}
