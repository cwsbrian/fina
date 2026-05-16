import { describe, expect, it } from "vitest";
import { estimateMessageTokens } from "../src/chat/token-estimate.js";

describe("estimateMessageTokens", () => {
  it("baseline for empty array: ceil('[]'.length / 4) = 1", () => {
    expect(estimateMessageTokens([])).toBe(1);
  });

  it("scales with payload size (~chars/4)", () => {
    const small = estimateMessageTokens([{ type: "text", markdown: "hi" }]);
    const big = estimateMessageTokens([{ type: "text", markdown: "x".repeat(4000) }]);
    expect(big).toBeGreaterThan(small);
    expect(big).toBeGreaterThanOrEqual(1000); // 4000 markdown chars ≈ 1000 tokens lower bound
    expect(big).toBeLessThan(1050); // small JSON overhead only
  });

  it("is stable for the same input", () => {
    const blocks = [{ type: "tool", toolName: "listAccounts", args: {}, result: { output: { accounts: [] } } }];
    expect(estimateMessageTokens(blocks)).toBe(estimateMessageTokens(blocks));
  });

  it("uses JSON serialization (object keys count toward size)", () => {
    const a = estimateMessageTokens({ a: 1 });
    const b = estimateMessageTokens({ aaaaaaaaaa: 1 });
    expect(b).toBeGreaterThan(a);
  });
});
