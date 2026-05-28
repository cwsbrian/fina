import { describe, expect, it } from "vitest";
import { collectPresentationBlocks, redactToolCallArgs } from "../src/chat/turn.js";

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
