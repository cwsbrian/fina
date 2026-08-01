import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(__dirname, "../../app/budget/new.tsx"),
  "utf8",
);

describe("current-month budget save", () => {
  it("saves to the same timezone-aware month returned by the API", () => {
    expect(source).toContain("setCurrentYearMonth(curResp.yearMonth)");
    expect(source).toContain("budget-plans/months/${currentYearMonth}");
    expect(source).not.toContain("getUTCFullYear");
    expect(source).not.toContain("getUTCMonth");
  });
});
