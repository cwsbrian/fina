import { describe, it, expect } from "vitest";
import { isOtherCategory } from "../src/categorize/other-detection.js";

describe("isOtherCategory", () => {
  it("exact 'Other' not archived → true", () => {
    expect(isOtherCategory({ name: "Other", archivedAt: null })).toBe(true);
  });
  it("lowercase 'other' → true", () => {
    expect(isOtherCategory({ name: "other", archivedAt: null })).toBe(true);
  });
  it("padded '  Other  ' → true", () => {
    expect(isOtherCategory({ name: "  Other  ", archivedAt: null })).toBe(true);
  });
  it("archived 'Other' → false (rule disabled)", () => {
    expect(isOtherCategory({ name: "Other", archivedAt: new Date() })).toBe(false);
  });
  it("'Misc' → false", () => {
    expect(isOtherCategory({ name: "Misc", archivedAt: null })).toBe(false);
  });
  it("'Others' (plural) → false", () => {
    expect(isOtherCategory({ name: "Others", archivedAt: null })).toBe(false);
  });
});
