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
  /** ISO 8601 timestamp; null when not archived. */
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
