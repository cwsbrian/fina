import { z } from "zod";
import { CADENCES, type PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
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

type FormDefaults = NonNullable<
  Extract<PresentationBlock, { type: "recurring_form_card" }>["defaults"]
>;

export const presentRecurringForm: ToolDef<
  Args,
  { block: PresentationBlock }
> = {
  name: "presentRecurringForm",
  description:
    "Display an inline form for adding OR modifying a recurring expense. Use this for BOTH add and modify intents — addRecurring upserts by name, so the same tool handles both. Mobile renders editable fields (name, amount, cadence, next-occurrence date) pre-filled with whatever defaults you can infer from the user message; the form auto-fills any field you omit from any existing recurring with the same name. DO NOT call listRecurring before this — the form looks up current values itself, so calling listRecurring first just emits a distracting list card the user didn't ask for. Use INSTEAD OF presentConfirmCard whenever the user is changing or adding a recurring expense.",
  args: Args,
  async run(ctx, args) {
    // Look up an existing recurring with this name (case-insensitive)
    // so the form pre-fills with the current row's values. Lets LLM
    // call presentRecurringForm directly for modify intents without
    // emitting a list card first.
    // RecurringExpense has no archivedAt column — remove is a hard
    // delete. Match by case-insensitive name within the workspace.
    const existing = await prisma.recurringExpense.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        name: { equals: args.defaults.name, mode: "insensitive" },
      },
      select: {
        name: true,
        amount: true,
        cadence: true,
        nextOccurrenceDate: true,
        categoryId: true,
      },
    });

    // Resolve category name for the form's category default — by name,
    // not id, so the form's defaults match the LLM's other arg shape.
    let existingCategoryName: string | null = null;
    if (existing?.categoryId) {
      const cat = await prisma.category.findFirst({
        where: { id: existing.categoryId, workspaceId: ctx.workspaceId },
        select: { name: true },
      });
      existingCategoryName = cat?.name ?? null;
    }

    // Merge order: LLM's explicit defaults WIN over existing values. So
    // 'change Netflix to $25' → LLM passes amount=25 → form shows 25 even
    // though existing is 20. Fields LLM didn't pass fall back to existing.
    const defaults: FormDefaults = {
      name: existing?.name ?? args.defaults.name,
    };
    const amount = args.defaults.amount ?? (existing ? Number(existing.amount) : undefined);
    if (amount !== undefined) defaults.amount = amount.toFixed(2);
    const cadence = args.defaults.cadence ?? existing?.cadence;
    if (cadence) defaults.cadence = cadence as NonNullable<FormDefaults["cadence"]>;
    const nextDate =
      args.defaults.next_occurrence_date ??
      (existing ? formatDate(existing.nextOccurrenceDate) : undefined);
    if (nextDate !== undefined) defaults.next_occurrence_date = nextDate;
    const categoryName = args.defaults.category_name ?? existingCategoryName ?? undefined;
    if (categoryName) defaults.category_name = categoryName;

    // Intent stores the same partial args; consume merges form overrides.
    const initialArgs: Record<string, unknown> = { name: defaults.name };
    if (defaults.amount !== undefined) initialArgs.amount = parseFloat(defaults.amount);
    if (defaults.cadence !== undefined) initialArgs.cadence = defaults.cadence;
    if (defaults.next_occurrence_date !== undefined) {
      initialArgs.next_occurrence_date = defaults.next_occurrence_date;
    }
    if (defaults.category_name !== undefined) {
      initialArgs.category_name = defaults.category_name;
    }

    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      {
        tool: "addRecurring",
        args: initialArgs,
        skipStrictValidate: true,
      },
    );

    return {
      block: {
        type: "recurring_form_card",
        question: args.question,
        intent_id: out.intent.id,
        defaults,
        currency: "CAD",
        mode: existing ? "update" : "add",
      },
    };
  },
};

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}
