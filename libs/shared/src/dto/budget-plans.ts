export type BudgetPlanDTO = {
  id: string;
  periodStart: string;
  totalAmount: string;
  categoryAllocations: Array<{ categoryId: string; amount: number }>;
};

export type BudgetCategorySpendDTO = {
  categoryId: string;
  categoryName: string;
  spent: number;
};

export type CurrentBudgetResponse = {
  currency: string;
  yearMonth: string;
  plan: BudgetPlanDTO | null;
  spendByCategory: BudgetCategorySpendDTO[];
  totalSpent: string;
  scheduledByCategory: BudgetCategorySpendDTO[];
  totalScheduled: string;
};

export type DefaultBudgetResponse = {
  currency: string;
  plan: BudgetPlanDTO | null;
  recentMonthlyAvgSpend: number | null;
};
