import { describe, expect, it } from "vitest";

import { shouldShowBudgetHero } from "./budget-hero";

describe("shouldShowBudgetHero", () => {
  it("shows the home budget hero when a budget exists even with no spending", () => {
    expect(shouldShowBudgetHero({ hasBudget: true, spent: 0, income: 0 })).toBe(true);
  });

  it("shows the home hero when the month only has income", () => {
    expect(shouldShowBudgetHero({ hasBudget: false, spent: 0, income: 2500 })).toBe(true);
  });

  it("keeps the hero hidden when there is no budget or cash flow", () => {
    expect(shouldShowBudgetHero({ hasBudget: false, spent: 0, income: 0 })).toBe(false);
  });
});
