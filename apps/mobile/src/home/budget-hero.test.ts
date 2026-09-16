import { describe, expect, it } from "vitest";

import { computeBudgetCap, shouldShowBudgetHero } from "./budget-hero";

it("uses the month's total budget, not the unchanged category allocations", () => {
  const plan = { totalAmount: "5000.00", categoryAllocations: [{ categoryId: "food", amount: 3000 }] };
  expect(computeBudgetCap(plan)).toBe(5000);
  expect(computeBudgetCap({ totalAmount: "0.00" })).toBe(0);
  expect(computeBudgetCap(null)).toBeNull();
});

describe("shouldShowBudgetHero", () => {
  it("shows the home budget hero when a budget exists even with no spending", () => {
    expect(shouldShowBudgetHero({ hasBudget: true, spent: 0 })).toBe(true);
  });

  it("keeps the hero hidden when there is no budget and no spending", () => {
    expect(shouldShowBudgetHero({ hasBudget: false, spent: 0 })).toBe(false);
  });
});
