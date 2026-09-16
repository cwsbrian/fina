export function computeBudgetCap(plan: { totalAmount: string } | null): number | null {
  return plan ? Number(plan.totalAmount) : null;
}

export function shouldShowBudgetHero({
  hasBudget,
  spent,
}: {
  hasBudget: boolean;
  spent: number;
}): boolean {
  return hasBudget || spent > 0;
}
