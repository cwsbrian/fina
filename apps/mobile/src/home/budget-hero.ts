export function shouldShowBudgetHero({
  hasBudget,
  spent,
}: {
  hasBudget: boolean;
  spent: number;
}): boolean {
  return hasBudget || spent > 0;
}
