import { z } from "zod";
import {
  GOAL_TITLE_MAX_LEN,
  GOAL_MAX_AMOUNT,
  minDueDateOneMonthUTC,
  isDueDateAtLeastOneMonth,
  type PresentationBlock,
} from "@fina/shared";
import { prisma } from "../../db.js";
import { effectiveTier } from "../../auth/tier.js";
import { createIntentService } from "../../intents/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  question: z.string().min(1).max(500),
  goal_id: z.string().min(1).optional(),
  defaults: z.object({
    title: z.string().min(1).max(GOAL_TITLE_MAX_LEN).optional(),
    target_amount: z.number().positive().max(GOAL_MAX_AMOUNT).optional(),
    due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
});
type Args = z.infer<typeof Args>;

type FormDefaults = NonNullable<
  Extract<PresentationBlock, { type: "goal_form_card" }>["defaults"]
>;

/** YYYY-MM-DD for the min-due-date floor (today + 1 month, UTC). */
function floorDateStr(): string {
  return minDueDateOneMonthUTC().toISOString().slice(0, 10);
}

export const presentGoalForm: ToolDef<Args, { block: PresentationBlock }> = {
  name: "presentGoalForm",
  description:
    "Display an inline form for creating OR editing a savings goal. Use for BOTH intents. Pass goal_id to edit an existing goal (the form pre-fills from it; any defaults you pass override). Pre-fill title / target_amount / due_date from the user's message where you can. Goals are a Pro feature — for a non-Pro user this returns a short upgrade message instead of a form. Savings accrue automatically; do NOT collect a 'saved' amount.",
  args: Args,
  async run(ctx, args) {
    // Pro gate up-front so a non-Pro user never fills a form that would
    // fail on submit.
    const tier = await effectiveTier(ctx.userId);
    if (tier.tier !== "pro") {
      return {
        block: {
          type: "text",
          markdown:
            "목표는 Pro 기능이에요 — 목표를 만들거나 수정하려면 Pro로 업그레이드해 주세요. / Goals are a Pro feature — upgrade to Pro to create or edit goals.",
        },
      };
    }

    // Edit mode: look up the existing goal to pre-fill omitted fields.
    // Fetch it (when editing) in parallel with the workspace currency —
    // both are independent of intent creation, which comes after.
    const [existing, workspace] = await Promise.all([
      args.goal_id
        ? prisma.goal.findFirst({
            where: { id: args.goal_id, workspaceId: ctx.workspaceId },
            select: { title: true, targetAmount: true, dueDate: true },
          })
        : Promise.resolve(null),
      prisma.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { currency: true },
      }),
    ]);

    // Merge: explicit defaults WIN over existing values.
    const title = args.defaults.title ?? existing?.title;
    const targetNum =
      args.defaults.target_amount ??
      (existing ? Number(existing.targetAmount) : undefined);

    // Due date: inferred → existing → floor. Clamp anything too soon up
    // to the floor so a happy-path submit can't fail the server refine.
    let dueDate =
      args.defaults.due_date ??
      (existing ? existing.dueDate.toISOString().slice(0, 10) : undefined);
    if (!dueDate || !isDueDateAtLeastOneMonth(dueDate)) {
      dueDate = floorDateStr();
    }

    const defaults: FormDefaults = {};
    if (title !== undefined) defaults.title = title;
    if (targetNum !== undefined) defaults.target_amount = targetNum.toFixed(2);
    defaults.due_date = dueDate;

    // Intent stores args matching the target tool's snake_case schema.
    // mode "update" binds to updateGoal (carries goal_id); "add" binds
    // to addGoal.
    const mode: "add" | "update" = args.goal_id ? "update" : "add";
    const initialArgs: Record<string, unknown> = {};
    if (mode === "update") initialArgs.goal_id = args.goal_id;
    if (title !== undefined) initialArgs.title = title;
    if (targetNum !== undefined) initialArgs.target_amount = targetNum;
    initialArgs.due_date = dueDate;

    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      {
        tool: mode === "update" ? "updateGoal" : "addGoal",
        args: initialArgs,
        skipStrictValidate: true,
      },
    );

    return {
      block: {
        type: "goal_form_card",
        question: args.question,
        intent_id: out.intent.id,
        defaults,
        currency: workspace.currency,
        mode,
      },
    };
  },
};
