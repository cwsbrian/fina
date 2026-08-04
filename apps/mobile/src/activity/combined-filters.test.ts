import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const activity = readFileSync(join(__dirname, "../../app/(tabs)/activity.tsx"), "utf8");
const filterRoute = readFileSync(join(__dirname, "../../app/activity/filters.tsx"), "utf8");
const filterScreen = readFileSync(join(__dirname, "ActivityFilterScreen.tsx"), "utf8");
const categorySheet = readFileSync(join(__dirname, "CategoryFilterSheet.tsx"), "utf8");

describe("Activity filters", () => {
  it("pushes a full-screen Stack route with focused date and category pickers", () => {
    expect(activity).toContain('router.push("/activity/filters" as never)');
    expect(activity).not.toContain("<Modal");
    expect(filterRoute).toContain('animation: "slide_from_right"');
    expect(filterRoute).toContain("topInset={insets.top}");
    expect(filterRoute).toContain("bottomInset={insets.bottom}");
    expect(filterRoute).toContain("<ActivityFilterScreen");
    expect(filterScreen).toContain("paddingTop: topInset");
    expect(filterScreen).toContain("Transaction type");
    expect(filterScreen).toContain('setPicker("direction")');
    expect(filterScreen).toContain('setPicker("date")');
    expect(filterScreen).toContain('setPicker("categories")');
    expect(filterScreen).toContain("<DateRangeSheet");
    expect(filterScreen).toContain("<CategoryFilterSheet");
    expect(categorySheet).toContain("All categories");
  });

  it("shows transaction type in its own Cancel and Apply sheet", () => {
    expect(filterScreen).toContain("<DirectionSheet");
    expect(filterScreen).toContain("accessibilityState={{ selected }}");
    expect(filterScreen).toContain("<Text style={styles.sheetCancel}>Cancel</Text>");
    expect(filterScreen).toContain("<Text style={styles.sheetApply}>Apply</Text>");
    expect(filterScreen).not.toContain("styles.segmentedControl");
  });

  it("puts Apply in the full-screen header and Reset in the gray footer button", () => {
    expect(filterScreen).toContain("<Text style={styles.headerActionText}>Apply</Text>");
    expect(filterScreen).toContain("<Text style={styles.resetButtonText}>Reset filters</Text>");
    expect(filterScreen).toContain("backgroundColor: colors.surfaceStrong");
    expect(filterScreen).toContain(
      'onPress={() => onApply({ direction: "all", range: {}, selectedCategoryIds: [] })}',
    );
  });

  it("uses a simple option list without a label or rounded container", () => {
    expect(filterScreen).not.toContain("FILTER BY");
    expect(filterScreen).not.toContain("styles.card");
    expect(filterScreen).not.toContain("styles.sectionLabel");
  });

  it("renders removable badges for every applied filter kind", () => {
    expect(activity).toContain("<ActivityFilterBadges");
    expect(activity).toContain("onClearDirection={clearDirectionFilter}");
    expect(activity).toContain("onClearDate={clearDateFilter}");
    expect(activity).toContain("onClearCategory={clearCategoryFilter}");
    expect(activity).toContain("selectedCategoryIds.map");
    expect(activity).toContain("Remove ${label} filter");
  });

  it("keeps the direction filter when loading another page", () => {
    const directionPathUses = activity.match(/directionFilterRef\.current/g) ?? [];
    expect(directionPathUses.length).toBeGreaterThanOrEqual(4);
  });
});
