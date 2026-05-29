import type { PresentationBlock } from "@fina/shared";
import type { ScheduledSpendStatus } from "@fina/shared";

export type ScheduledRowInput = {
  id: string;
  categoryId: string;
  amount: string;
  /** YYYY-MM-DD */
  scheduledDate: string;
  note: string | null;
  status: ScheduledSpendStatus;
};

/** Build the scheduled_list card shared by listScheduledSpends and
 *  listUnresolvedSchedules. `dismissIntentById` maps a schedule id to a
 *  pre-created dismissScheduledSpend intent — present only for the
 *  unresolved variant. */
export function buildScheduledListBlock(opts: {
  title: string;
  currency: string;
  schedules: ScheduledRowInput[];
  catById: Map<string, { name: string; color: string | null; icon: string | null }>;
  dismissIntentById?: Map<string, string>;
}): Extract<PresentationBlock, { type: "scheduled_list" }> {
  const { title, currency, schedules, catById, dismissIntentById } = opts;
  return {
    type: "scheduled_list",
    title,
    total_count: schedules.length,
    currency,
    rows: schedules.map((s) => {
      const cat = catById.get(s.categoryId);
      const categoryName = cat?.name ?? "Unknown";
      const dismiss = dismissIntentById?.get(s.id);
      return {
        id: s.id,
        name: s.note ?? categoryName,
        amount: s.amount,
        scheduled_date: s.scheduledDate,
        status: s.status,
        ...(cat ? { category: { name: cat.name, color: cat.color, icon: cat.icon } } : {}),
        ...(dismiss ? { dismiss_intent: dismiss } : {}),
      };
    }),
  };
}
