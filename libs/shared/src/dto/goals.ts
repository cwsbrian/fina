/** One row in a Fina-generated savings plan ("trim Dining by $80/mo"). */
export type GoalStrategyItem = {
  categoryName: string;
  monthlyAmount: number;
  rationale: string;
};

export type GoalStrategy = {
  items: GoalStrategyItem[];
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
  /** Decimal serialized as a string. Manually set in v1. */
  savedAmount: string;
  /** YYYY-MM-DD. */
  dueDate: string;
  icon: string | null;
  color: string | null;
  /** Null until the background LLM finishes generating one. */
  strategy: GoalStrategy | null;
  /** ISO 8601 timestamp; null when not archived. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
