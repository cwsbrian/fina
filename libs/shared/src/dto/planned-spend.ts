import type { Cadence } from "../enums.js";

export type ScheduledSpendDTO = {
  id: string;
  categoryId: string;
  amount: string;
  scheduledDate: string;
  note: string | null;
  matchedTxId: string | null;
  dismissedAt: string | null;
  status: "upcoming" | "unresolved" | "resolved-matched" | "resolved-dismissed";
};

export type RecurringExpenseDTO = {
  id: string;
  name: string;
  amount: string;
  currency: string;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId: string | null;
  categoryName: string | null;
  merchantNormalized: string | null;
  monthlyEquivalent: string;
  remainingThisMonth: string[];
  createdAt: string;
};
