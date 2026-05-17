import { describe, it, expect } from "vitest";
import { cleanTitle } from "../src/chat/auto-title.js";

describe("cleanTitle", () => {
  it("trims whitespace", () => {
    expect(cleanTitle("  Coffee 카테고리 추가  ")).toBe("Coffee 카테고리 추가");
  });

  it("strips matched double quotes", () => {
    expect(cleanTitle('"Coffee 카테고리 추가"')).toBe("Coffee 카테고리 추가");
  });

  it("strips matched single quotes", () => {
    expect(cleanTitle("'Coffee 카테고리'")).toBe("Coffee 카테고리");
  });

  it("takes first non-empty line", () => {
    expect(cleanTitle("Coffee 카테고리\nSecond line")).toBe("Coffee 카테고리");
  });

  it("skips empty leading lines before taking first non-empty line", () => {
    expect(cleanTitle("\n\n  Coffee 카테고리  \nLater")).toBe("Coffee 카테고리");
  });

  it("returns null for empty input", () => {
    expect(cleanTitle("")).toBeNull();
  });

  it("returns null for whitespace-only input", () => {
    expect(cleanTitle("   \n\t")).toBeNull();
  });

  it("returns null when nothing remains after quote stripping", () => {
    expect(cleanTitle('""')).toBeNull();
  });

  it("caps at 200 chars (DB column max)", () => {
    expect(cleanTitle("a".repeat(250))).toHaveLength(200);
  });
});
