/** One row in a Fina-generated savings plan. Lives in the
 *  `goal_allocations` table — properly FK'd to a category, not a
 *  free-text name. */
export type GoalAllocationDTO = {
  categoryId: string;
  /** Joined from `categories.name` for display. */
  categoryName: string;
  /** Joined from `categories.icon` so the row glyph can match the
   *  same icon the category uses elsewhere. Null when no icon set. */
  categoryIcon: string | null;
  /** Joined from `categories.color`. Null when no color is set. */
  categoryColor: string | null;
  /** Decimal serialized as a string. */
  monthlyAmount: string;
  /** LLM-generated one-liner; may be null if the row was created
   *  without one. */
  rationale: string | null;
};

/** Generator metadata for the savings plan. Per-row data lives in
 *  `allocations` (above) — this object is just the timestamp + an
 *  optional notice. */
export type GoalStrategy = {
  generatedAt: string;
  /** Set when the LLM couldn't build a useful plan (e.g. no spend
   *  history yet) — UI surfaces this to the user. */
  notice?: string;
};

/** A savings goal — "save $2,000 for a trip by Nov 12". */
export type GoalDTO = {
  id: string;
  title: string;
  description: string | null;
  /** Decimal serialized as a string. */
  targetAmount: string;
  /** Decimal serialized as a string. Auto-derived from actual
   *  under-budget behavior on the allocations below. */
  savedAmount: string;
  /** YYYY-MM-DD. */
  dueDate: string;
  icon: string | null;
  color: string | null;
  /** Null until the background LLM finishes generating one. Carries
   *  just the timestamp + an optional notice. */
  strategy: GoalStrategy | null;
  /** Per-category cuts from the LLM plan. Empty array until the
   *  generator runs or if it couldn't resolve any category. */
  allocations: GoalAllocationDTO[];
  /** ISO 8601 timestamp; null when not archived. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
