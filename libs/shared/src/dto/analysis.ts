export type CategorySpendDTO = {
  categoryId: string;
  categoryName: string;
  icon: string | null;
  color: string | null;
  amount: number;
};

export type MonthAnalysisDTO = {
  year: number;
  month: number;
  label: string;
  income: number;
  spend: number;
  net: number;
  spendByCategory: CategorySpendDTO[];
};

export type AnalysisResponse = {
  current: MonthAnalysisDTO;
  previous: MonthAnalysisDTO | null;
  monthlyHistory: Array<{
    year: number;
    month: number;
    label: string;
    income: number;
    spend: number;
  }>;
};
