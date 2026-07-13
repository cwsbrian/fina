import { describe, expect, it } from "vitest";
import { collectPresentationBlocks, redactToolCallArgs, SYSTEM_PROMPT } from "../src/chat/turn.js";

describe("collectPresentationBlocks", () => {
  it("collects block from a tool result that has { output: { block: {...} } } shape", () => {
    const blocks = collectPresentationBlocks([
      {
        result: {
          output: {
            block: {
              type: "confirm_card",
              question: "Q",
              accept_label: "확인",
              reject_label: "취소",
              accept_intent: "int-1",
              expiresAt: "2026-05-17T22:00:00.000Z",
            },
          },
        },
      },
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("confirm_card");
  });

  it("ignores tool results without a block field", () => {
    const blocks = collectPresentationBlocks([
      { result: { output: { category: { id: "c1", name: "Coffee" } } } },
      { result: { error: "category_not_found" } },
      { result: null },
    ]);
    expect(blocks).toHaveLength(0);
  });
});

describe("redactToolCallArgs", () => {
  it("strips accept_action from presentConfirmCard args", () => {
    const result = redactToolCallArgs("presentConfirmCard", {
      question: "Q",
      accept_action: { tool: "createCategory", args: { name: "Coffee" } },
    });
    expect(result).toEqual({ question: "Q" });
    expect(result).not.toHaveProperty("accept_action");
  });

  it("passes through args for other tools unchanged", () => {
    const result = redactToolCallArgs("createCategory", { name: "Coffee" });
    expect(result).toEqual({ name: "Coffee" });
  });
});

describe("chat forecast prompt", () => {
  it("forbids inventing higher category forecasts from timing patterns", () => {
    expect(SYSTEM_PROMPT).toContain("Use the returned projected number as-is");
    expect(SYSTEM_PROMPT).toContain("do not claim \"last month was $400 so this month will be $600\"");
  });
});

describe("manual transaction prompt", () => {
  it("defaults ordinary purchases to manual transactions without budget noise", () => {
    expect(SYSTEM_PROMPT).toContain("Ordinary purchases are one-time manual transactions by default");
    expect(SYSTEM_PROMPT).toContain("call addManualTransaction directly");
    expect(SYSTEM_PROMPT).toContain("Do not call budget tools or show a budget card");
    expect(SYSTEM_PROMPT).not.toContain("Transactions cannot be manually added");
  });
});
