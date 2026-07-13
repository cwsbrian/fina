import { describe, expect, it } from "vitest";
import { summarizeForecast } from "../src/chat/brief-context.js";
import type { MonthEndForecast, CategoryForecast } from "../src/analysis/forecast.js";
import type { RiskTier } from "@fina/shared";

// Build a CategoryForecast fixture; only the fields summarizeForecast reads matter.
function cat(
  categoryName: string,
  severity: RiskTier,
  projectedOverspend: number,
  projected = 0,
  cap = 0,
): CategoryForecast {
  return {
    categoryId: categoryName.toLowerCase(),
    categoryName,
    cap,
    spent: 0,
    fixedBills: 0,
    plannedOneOffs: 0,
    discRate: 0,
    daysLeft: 10,
    projected,
    projectedOverspend,
    projectedUnderspend: 0,
    runwayDay: null,
    severity,
    typicalAmount: 0,
    historyMonths: 0,
    historicalMonthlyAverage: 0,
    historicalOverspendMonths: 0,
    currentPaceRatio: null,
  };
}

function forecast(
  portfolio: MonthEndForecast["portfolio"],
  categories: CategoryForecast[] = [],
  daysLeft = 10,
): MonthEndForecast {
  return { year: 2026, month: 5, daysLeft, categories, portfolio };
}

describe("summarizeForecast", () => {
  it("on_track portfolio: zero overspend, empty topRisks, hasHistory true", () => {
    const out = summarizeForecast(
      forecast({ cap: 1000, spent: 200, scheduled: 0, projected: 800, severity: "on_track" }),
      "CAD",
    );
    expect(out.portfolio).not.toBeNull();
    expect(out.portfolio!.severity).toBe("on_track");
    expect(out.portfolio!.projectedOverBudget).toBe(false);
    expect(out.portfolio!.overspend).toBe("$0.00");
    expect(out.portfolio!.cap).toBe("$1,000.00");
    expect(out.topRisks).toEqual([]);
    expect(out.historicalPatterns).toEqual([]);
    expect(out.hasHistory).toBe(true);
    expect(out.daysLeft).toBe(10);
  });

  it("at_risk portfolio: caps topRisks at 3, sorted by overspend desc, drops lowest qualifier", () => {
    const out = summarizeForecast(
      forecast({ cap: 1000, spent: 1300, scheduled: 0, projected: 1300, severity: "at_risk" }, [
        cat("A", "at_risk", 300, 800, 500),
        cat("B", "at_risk", 500, 1000, 500),
        cat("C", "at_risk", 100, 600, 500),
        cat("D", "watch", 50, 530, 500),
        cat("E", "on_track", 0, 100, 500),
        cat("F", "insufficient_history", 0, 0, 0),
      ]),
      "CAD",
    );
    expect(out.topRisks.map((r) => r.category)).toEqual(["B", "A", "C"]); // desc by overspend, top 3
    // D (lowest qualifier) dropped; on_track + insufficient_history excluded
    expect(out.topRisks.every((r) => r.severity === "watch" || r.severity === "at_risk")).toBe(
      true,
    );
    expect(out.portfolio!.projectedOverBudget).toBe(true);
  });

  it("cap<=0: portfolio null but topRisks + daysLeft survive", () => {
    const out = summarizeForecast(
      forecast(
        { cap: 0, spent: 0, scheduled: 0, projected: 0, severity: "on_track" },
        [cat("Dining", "at_risk", 200, 700, 500)],
        7,
      ),
      "CAD",
    );
    expect(out.portfolio).toBeNull();
    expect(out.topRisks.map((r) => r.category)).toEqual(["Dining"]);
    expect(out.daysLeft).toBe(7);
  });

  it("cap>0 but projected 0: portfolio present, hasHistory false", () => {
    const out = summarizeForecast(
      forecast({ cap: 1000, spent: 0, scheduled: 0, projected: 0, severity: "on_track" }),
      "CAD",
    );
    expect(out.portfolio).not.toBeNull();
    expect(out.portfolio!.severity).toBe("on_track");
    expect(out.hasHistory).toBe(false);
  });

  it("keeps repeated historical overspending separate from current top risks", () => {
    const shopping = {
      ...cat("Shopping", "on_track", 0, 300, 500),
      historyMonths: 3,
      historicalMonthlyAverage: 600,
      historicalOverspendMonths: 3,
      currentPaceRatio: 0.5,
    };
    const out = summarizeForecast(
      forecast({ cap: 1000, spent: 150, scheduled: 0, projected: 300, severity: "on_track" }, [
        shopping,
      ]),
      "CAD",
    );
    expect(out.topRisks).toEqual([]);
    expect(out.historicalPatterns).toEqual([
      {
        category: "Shopping",
        average: "$600.00",
        cap: "$500.00",
        monthsOverBudget: 3,
        monthsObserved: 3,
        currentPace: "slower",
      },
    ]);
    expect(out.hasHistory).toBe(true);
  });
});
