import { z } from "zod";
import { Prisma } from "@prisma/client";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { normalizeMerchant } from "../../categorize/normalize.js";
import { createIntentService } from "../../intents/service.js";
import type { ToolDef } from "./types.js";
import { lookbackMonthStart } from "./periods.js";
import { budgetExpenseTransactionWhere } from "../../transactions/budget-impact.js";

const Args = z.object({
  lookback_months: z
    .number()
    .int()
    .min(2)
    .max(12)
    .describe("How many months of transactions to inspect. Defaults to 6, min 2, max 12.")
    .optional(),
  min_occurrences: z
    .number()
    .int()
    .min(2)
    .max(12)
    .describe("Minimum number of merchant occurrences required. Defaults to 3.")
    .optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(25)
    .describe("Maximum recurring merchant candidates to return. Defaults to 10, hard cap 25.")
    .optional(),
});

type Args = z.infer<typeof Args>;

type Candidate = {
  key: string;
  merchantNormalized: string;
  displayName: string;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  medianAmount: string;
  latestAmount: string;
  currency: string;
  cadence: "weekly" | "biweekly" | "monthly" | "irregular";
  confidence: number;
  transactionIds: string[];
};


type Result = {
  lookbackMonths: number;
  candidates: Candidate[];
  block?: PresentationBlock;
};

/** Next expected charge = last seen + one cadence interval. The detector
 *  has no native next-date; this seeds the form's date field, which the
 *  user can still adjust. Irregular candidates never reach here. */
function deriveNextOccurrence(
  lastSeenIso: string,
  cadence: "weekly" | "biweekly" | "monthly",
): string {
  const d = new Date(lastSeenIso);
  if (cadence === "weekly") d.setUTCDate(d.getUTCDate() + 7);
  else if (cadence === "biweekly") d.setUTCDate(d.getUTCDate() + 14);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function classifyCadence(medianGapDays: number): Candidate["cadence"] {
  if (medianGapDays >= 6 && medianGapDays <= 8) return "weekly";
  if (medianGapDays >= 12 && medianGapDays <= 16) return "biweekly";
  if (medianGapDays >= 27 && medianGapDays <= 34) return "monthly";
  return "irregular";
}

function cadenceRegularityScore(gaps: number[], medianGap: number, cadence: Candidate["cadence"]): number {
  if (cadence === "irregular" || gaps.length === 0) return 0;
  // Mean absolute deviation as a fraction of medianGap. Lower MAD → higher score.
  const mad = gaps.reduce((s, g) => s + Math.abs(g - medianGap), 0) / gaps.length;
  const relative = mad / medianGap;
  return Math.max(0, 1 - Math.min(1, relative * 2)); // 0..1
}

function amountStabilityScore(amounts: number[]): number {
  if (amounts.length === 0) return 0;
  const med = median(amounts);
  if (med === 0) return 0;
  const mad = amounts.reduce((s, a) => s + Math.abs(a - med), 0) / amounts.length;
  return Math.max(0, 1 - Math.min(1, mad / med));
}

export const detectRecurringMerchants: ToolDef<Args, Result> = {
  name: "detectRecurringMerchants",
  description:
    "Detect likely recurring merchant payments from recent transaction history using cadence and amount stability heuristics.",
  args: Args,
  async run(ctx, args) {
    const lookbackMonths = args.lookback_months ?? 6;
    const minOccurrences = args.min_occurrences ?? 3;
    const limit = args.limit ?? 10;

    // First day of the calendar month that begins the lookback window, in the user's timezone,
    // converted to a UTC instant. The shared helper resolves User.tz (with America/Toronto
    // fallback for missing/invalid values) and handles DST.
    const lookbackStart = await lookbackMonthStart(ctx.userId, lookbackMonths);

    const rows = await prisma.transaction.findMany({
      where: budgetExpenseTransactionWhere({
        workspaceId: ctx.workspaceId,
        occurredAt: { gte: lookbackStart },
      }),
      select: {
        id: true,
        amount: true,
        merchantRaw: true,
        merchantNormalized: true,
        occurredAt: true,
        account: { select: { currency: true } },
      },
      orderBy: { occurredAt: "asc" },
    });

    type Group = {
      key: string;
      merchantKey: string;
      currency: string;
      displayName: string;
      latestDisplayTs: number;
      transactionIds: string[];
      amounts: Prisma.Decimal[];
      occurredAts: Date[];
    };
    const groups = new Map<string, Group>();

    for (const r of rows) {
      const merchantKey = (r.merchantNormalized ?? normalizeMerchant(r.merchantRaw)).trim();
      if (!merchantKey) continue;
      const currency = r.account.currency;
      const key = `${merchantKey}|${currency}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          merchantKey,
          currency,
          displayName: r.merchantRaw,
          latestDisplayTs: r.occurredAt.getTime(),
          transactionIds: [],
          amounts: [],
          occurredAts: [],
        };
        groups.set(key, g);
      }
      g.transactionIds.push(r.id);
      g.amounts.push(new Prisma.Decimal(r.amount));
      g.occurredAts.push(r.occurredAt);
      if (r.occurredAt.getTime() >= g.latestDisplayTs) {
        g.displayName = r.merchantRaw;
        g.latestDisplayTs = r.occurredAt.getTime();
      }
    }

    const candidates: Candidate[] = [];
    for (const g of groups.values()) {
      if (g.occurredAts.length < minOccurrences) continue;
      const sortedTimes = g.occurredAts.map((d) => d.getTime()).sort((a, b) => a - b);
      const gaps: number[] = [];
      for (let i = 1; i < sortedTimes.length; i++) {
        gaps.push((sortedTimes[i]! - sortedTimes[i - 1]!) / (1000 * 60 * 60 * 24));
      }
      const medianGap = median(gaps);
      const cadence = classifyCadence(medianGap);
      const amountNums = g.amounts.map((a) => parseFloat(a.toFixed(2)));
      const medianAmt = median(amountNums);

      const occScore = Math.min(1, g.occurredAts.length / Math.max(minOccurrences, 4)) * 0.4;
      const cadenceScore = cadenceRegularityScore(gaps, medianGap, cadence) * 0.4;
      const stabilityScore = amountStabilityScore(amountNums) * 0.2;
      const confidence = Math.max(0, Math.min(1, occScore + cadenceScore + stabilityScore));

      if (confidence < 0.45) continue;

      // Find the amount for the latest occurrence by scanning the parallel arrays;
      // findIndex would return only the first match if timestamps collided.
      // Length is guaranteed >= minOccurrences (>= 2) by the continue guard above.
      let latestAmount = g.amounts[0]!;
      let latestTs = g.occurredAts[0]!.getTime();
      for (let i = 1; i < g.amounts.length; i++) {
        const ts = g.occurredAts[i]!.getTime();
        if (ts > latestTs) {
          latestTs = ts;
          latestAmount = g.amounts[i]!;
        }
      }
      const firstTs = sortedTimes[0]!;
      const lastTs = sortedTimes[sortedTimes.length - 1]!;

      candidates.push({
        key: g.key,
        merchantNormalized: g.merchantKey,
        displayName: g.displayName,
        occurrences: g.occurredAts.length,
        firstSeenAt: new Date(firstTs).toISOString(),
        lastSeenAt: new Date(lastTs).toISOString(),
        medianAmount: medianAmt.toFixed(2),
        latestAmount: latestAmount.toFixed(2),
        currency: g.currency,
        cadence,
        confidence: Math.round(confidence * 100) / 100,
        transactionIds: g.transactionIds,
      });
    }

    candidates.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return parseFloat(b.latestAmount) - parseFloat(a.latestAmount);
    });

    const top = candidates.slice(0, limit);
    const stable = top.filter(
      (c): c is Candidate & { cadence: "weekly" | "biweekly" | "monthly" } =>
        c.cadence === "weekly" || c.cadence === "biweekly" || c.cadence === "monthly",
    );

    let block: PresentationBlock | undefined;
    if (stable.length > 0) {
      // One addRecurring form intent per stable candidate (≤limit). Re-calling
      // creates fresh intents (no dedup); the hourly ActionIntent sweep + 1h TTL
      // bound the accumulation. The card uses the latest id.
      const rows: Extract<PresentationBlock, { type: "recurring_candidates" }>["rows"] =
        await Promise.all(
          stable.map(async (c) => {
            const nextDate = deriveNextOccurrence(c.lastSeenAt, c.cadence);
            const intent = await createIntentService(
              { workspaceId: ctx.workspaceId, userId: ctx.userId },
              {
                tool: "addRecurring",
                args: {
                  name: c.displayName,
                  amount: parseFloat(c.medianAmount),
                  cadence: c.cadence,
                  next_occurrence_date: nextDate,
                },
                skipStrictValidate: true,
              },
            );
            return {
              merchant: c.displayName,
              amount: c.medianAmount,
              cadence: c.cadence,
              occurrences: c.occurrences,
              add_form_intent: intent.intent.id,
              defaults: {
                name: c.displayName,
                amount: c.medianAmount,
                cadence: c.cadence,
                next_occurrence_date: nextDate,
              },
            };
          }),
        );
      block = {
        type: "recurring_candidates",
        title: "Possible subscriptions",
        currency: stable[0]!.currency,
        rows,
      };
    }

    return {
      lookbackMonths,
      candidates: top,
      ...(block ? { block } : {}),
    };
  },
};
