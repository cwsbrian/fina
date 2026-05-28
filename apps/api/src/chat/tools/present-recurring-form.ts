import { z } from "zod";
import { CADENCES, type PresentationBlock } from "@fina/shared";
import { createIntentService } from "../../intents/service.js";
import type { ToolDef } from "./types.js";

const Args = z.object({
  question: z.string().min(1).max(500),
  defaults: z.object({
    name: z.string().min(1).max(100),
    amount: z.number().positive().optional(),
    cadence: z.enum(CADENCES).optional(),
    next_occurrence_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    category_name: z.string().min(1).max(40).optional(),
  }),
});

type Args = z.infer<typeof Args>;

export const presentRecurringForm: ToolDef<
  Args,
  { block: PresentationBlock }
> = {
  name: "presentRecurringForm",
  description:
    "Display an inline form to add a recurring expense. Mobile renders editable fields for amount, cadence, and next occurrence date pre-filled with whatever defaults you can infer from the user message. Use INSTEAD OF presentConfirmCard when the user wants to add a recurring expense but at least one of amount / cadence / next_occurrence_date is missing or unclear — the user will fill in the rest in the form, no back-and-forth required. The form submits straight to addRecurring with the user's edited values.",
  args: Args,
  async run(ctx, args) {
    // Create the intent with partial args — the form will fill in the
    // rest at submit time. Skip strict validation so missing required
    // fields (amount, cadence, next_occurrence_date) don't reject the
    // create call.
    const initialArgs: Record<string, unknown> = { name: args.defaults.name };
    if (args.defaults.amount !== undefined) initialArgs.amount = args.defaults.amount;
    if (args.defaults.cadence !== undefined) initialArgs.cadence = args.defaults.cadence;
    if (args.defaults.next_occurrence_date !== undefined) {
      initialArgs.next_occurrence_date = args.defaults.next_occurrence_date;
    }
    if (args.defaults.category_name !== undefined) {
      initialArgs.category_name = args.defaults.category_name;
    }

    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      {
        tool: "addRecurring",
        args: initialArgs,
        skipStrictValidate: true,
      },
    );

    const defaults: NonNullable<
      Extract<PresentationBlock, { type: "recurring_form_card" }>["defaults"]
    > = {
      name: args.defaults.name,
    };
    if (args.defaults.amount !== undefined) defaults.amount = args.defaults.amount.toFixed(2);
    if (args.defaults.cadence !== undefined) defaults.cadence = args.defaults.cadence;
    if (args.defaults.next_occurrence_date !== undefined) {
      defaults.next_occurrence_date = args.defaults.next_occurrence_date;
    }
    if (args.defaults.category_name !== undefined) {
      defaults.category_name = args.defaults.category_name;
    }

    return {
      block: {
        type: "recurring_form_card",
        question: args.question,
        intent_id: out.intent.id,
        defaults,
        currency: "CAD",
      },
    };
  },
};
