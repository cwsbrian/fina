import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { parseOccurredAt } from "@fina/shared";
import { prisma } from "../../db.js";
import { createIntentService } from "../../intents/service.js";
import { workspaceOwnerTz, todayDateOnlyInTz } from "../../schedules/service.js";
import type { ToolDef } from "./types.js";
import { ScheduledPlanItem } from "./_scheduled-plan-item.js";

const Args = z.object({
  question: z.string().min(1).max(500),
  items: z.array(ScheduledPlanItem).min(1).max(20),
});

type PlanCard = Extract<PresentationBlock, { type: "plan_proposal_card" }>;

export const presentScheduledSpendPlan: ToolDef<z.infer<typeof Args>, { block: PlanCard }> = {
  name: "presentScheduledSpendPlan",
  description:
    "Propose a concrete multi-item spending plan as ONE Yes/No card; accept creates all items as scheduled spends. " +
    "Use after a forecast shows a category will run tight, or when the user asks for help planning. Dates MUST be in the " +
    "future; categories must already exist; size amounts from the user's words or the category's typicalAmount/remaining.",
  args: Args,
  async run(ctx, args) {
    // Resolve categories deterministically (same orderBy as the executor).
    const cats = await prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    // Build canonical-cased name map (first-wins by orderBy)
    const canonical = new Map<string, string>();
    for (const c of cats) {
      const k = c.name.toLowerCase();
      if (!canonical.has(k)) canonical.set(k, c.name);
    }

    // Reject unknown categories + past dates BEFORE creating the single-use intent.
    const today = todayDateOnlyInTz(await workspaceOwnerTz(ctx.workspaceId)).getTime();
    for (const it of args.items) {
      if (!canonical.has(it.category.toLowerCase())) throw new Error("category_not_found");
      if (parseOccurredAt(it.scheduled_date).getTime() < today) throw new Error("date_in_past");
    }

    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { tool: "addScheduledSpendBatch", args: { items: args.items } },
    );

    const total = args.items.reduce((s, it) => s + it.amount, 0);

    return {
      block: {
        type: "plan_proposal_card",
        question: args.question,
        rows: args.items.map((it) => ({
          category: canonical.get(it.category.toLowerCase())!,
          date: it.scheduled_date,
          amount: it.amount.toFixed(2),
          ...(it.note !== undefined ? { note: it.note } : {}),
        })),
        total: total.toFixed(2),
        // UI chrome stays English (North-America launch) regardless of the
        // conversation language — the LLM-authored `question` carries the
        // localized message, the buttons do not.
        accept_label: "Schedule it",
        reject_label: "Not now",
        accept_intent: out.intent.id,
      },
    };
  },
};
