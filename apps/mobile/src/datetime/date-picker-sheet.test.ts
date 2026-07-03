import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function readMobile(rel: string) {
  return readFileSync(path.join(__dirname, "..", "..", rel), "utf8");
}

describe("DatePickerSheet", () => {
  it("keeps the iOS spinner readable on light sheets", () => {
    const source = readMobile("src/datetime/DatePickerSheet.tsx");

    expect(source).toContain('display="spinner"');
    expect(source).toContain("textColor={colors.ink}");
    expect(source).toContain('themeVariant="light"');
  });
});
