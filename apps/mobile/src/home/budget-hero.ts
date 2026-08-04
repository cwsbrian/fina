export function shouldShowBudgetHero({
  hasBudget,
  spent,
  income,
}: {
  hasBudget: boolean;
  spent: number;
  income: number;
}): boolean {
  return hasBudget || spent > 0 || income > 0;
}
