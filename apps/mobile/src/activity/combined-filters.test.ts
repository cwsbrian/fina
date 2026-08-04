import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const activity = readFileSync(join(__dirname, "../../app/(tabs)/activity.tsx"), "utf8");
const sheet = readFileSync(join(__dirname, "CategoryFilterSheet.tsx"), "utf8");

describe("combined Activity filters", () => {
  it("opens one filter surface for direction, date, and category", () => {
    expect(activity).toContain('accessibilityLabel="Filter transactions"');
    expect(activity).not.toContain('accessibilityLabel="Date range"');
    expect(sheet).toContain("Transaction type");
    expect(sheet).toContain("Expenses");
    expect(sheet).toContain("Income");
    expect(sheet).toContain("Date");
    expect(sheet).toContain("Categories");
  });

  it("keeps the direction filter when loading another page", () => {
    const directionPathUses = activity.match(/directionFilterRef\.current/g) ?? [];
    expect(directionPathUses.length).toBeGreaterThanOrEqual(4);
  });
});
