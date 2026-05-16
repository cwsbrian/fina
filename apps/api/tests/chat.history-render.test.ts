import { describe, expect, it } from "vitest";
import { toGeminiHistory } from "../src/chat/turn.js";

// Regression for the history-trim orphan tool row issue (codex pass 4).
// When selectHistoryWindow cuts between a user message and its tool/assistant
// continuation, the chronological slice can start with a tool row. toGeminiHistory
// expands tool rows into (model functionCall + user functionResponse), so without
// extra stripping Gemini would receive an orphan user-functionResponse with no
// matching functionCall and reject the request.

describe("toGeminiHistory leading-orphan stripping", () => {
  it("drops leading model entries (assistant-first slice)", () => {
    const out = toGeminiHistory([
      { role: "assistant", blocks: [{ type: "text", markdown: "orphan" }] },
      { role: "user", blocks: [{ type: "text", markdown: "real start" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: "user", parts: [{ text: "real start" }] });
  });

  it("drops leading user functionResponse with no matching functionCall (tool-first slice)", () => {
    const out = toGeminiHistory([
      { role: "tool", blocks: [{ type: "tool", toolName: "listCategories", args: {}, result: { output: { categories: [] } } }] },
      { role: "user", blocks: [{ type: "text", markdown: "real start" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: "user", parts: [{ text: "real start" }] });
  });

  it("strips repeated orphan tool rows until a user-text appears", () => {
    const out = toGeminiHistory([
      { role: "tool", blocks: [{ type: "tool", toolName: "a", args: {}, result: { output: {} } }] },
      { role: "tool", blocks: [{ type: "tool", toolName: "b", args: {}, result: { output: {} } }] },
      { role: "assistant", blocks: [{ type: "text", markdown: "interim" }] },
      { role: "user", blocks: [{ type: "text", markdown: "real start" }] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: "user", parts: [{ text: "real start" }] });
  });

  it("preserves a coherent user → assistant → user dialogue", () => {
    const out = toGeminiHistory([
      { role: "user", blocks: [{ type: "text", markdown: "hi" }] },
      { role: "assistant", blocks: [{ type: "text", markdown: "hello" }] },
      { role: "user", blocks: [{ type: "text", markdown: "bye" }] },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "user", parts: [{ text: "hi" }] });
    expect(out[1]).toEqual({ role: "model", parts: [{ text: "hello" }] });
    expect(out[2]).toEqual({ role: "user", parts: [{ text: "bye" }] });
  });

  it("expands tool row into functionCall+functionResponse when anchored by a prior user", () => {
    const out = toGeminiHistory([
      { role: "user", blocks: [{ type: "text", markdown: "list cats" }] },
      { role: "tool", blocks: [{ type: "tool", toolName: "listCategories", args: {}, result: { output: { categories: [] } } }] },
      { role: "assistant", blocks: [{ type: "text", markdown: "you have 0" }] },
    ]);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ role: "user", parts: [{ text: "list cats" }] });
    expect(out[1]).toMatchObject({ role: "model", parts: [{ functionCall: { name: "listCategories" } }] });
    expect(out[2]).toMatchObject({ role: "user", parts: [{ functionResponse: { name: "listCategories" } }] });
    expect(out[3]).toEqual({ role: "model", parts: [{ text: "you have 0" }] });
  });

  it("returns empty array when nothing but orphan rows exist", () => {
    const out = toGeminiHistory([
      { role: "tool", blocks: [{ type: "tool", toolName: "x", args: {}, result: { output: {} } }] },
      { role: "assistant", blocks: [{ type: "text", markdown: "stranded" }] },
    ]);
    expect(out).toHaveLength(0);
  });
});
