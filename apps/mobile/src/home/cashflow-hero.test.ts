import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "../../app/(tabs)/index.tsx"), "utf8");

describe("Home cash-flow hero", () => {
  it("shows both monthly income and expenses", () => {
    expect(source).toContain("{monthLabel} cash flow");
    expect(source).toContain("Income</Text>");
    expect(source).toContain("Expenses</Text>");
    expect(source).toContain("+{incomeDisplay}");
    expect(source).toContain("−{spentDisplay}");
  });

  it("loads income for the timezone-aware month returned by the budget API", () => {
    expect(source).toContain('const [year, month] = r.yearMonth.split("-").map(Number)');
    expect(source).toContain("/analysis?year=${year}&month=${month}");
  });
});
