import { describe, expect, it } from "vitest";
import { selectHistoryWindow, type HistoryCandidate } from "../src/chat/history-window.js";

function msg(
  id: string,
  blocks: unknown = [{ type: "text", markdown: id }],
  createdAt = new Date("2026-05-15T00:00:00Z"),
): HistoryCandidate {
  return { id, blocks, createdAt };
}

describe("selectHistoryWindow", () => {
  it("returns all messages chronologically when both caps are slack", () => {
    const newestFirst = [msg("c", "third"), msg("b", "second"), msg("a", "first")];
    const r = selectHistoryWindow(newestFirst, { limitMessages: 10, budgetTokens: 1_000 });
    expect(r.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("applies the count cap (keeps the N newest)", () => {
    const newestFirst = [msg("e"), msg("d"), msg("c"), msg("b"), msg("a")];
    const r = selectHistoryWindow(newestFirst, { limitMessages: 3, budgetTokens: 1_000_000 });
    expect(r.map((m) => m.id)).toEqual(["c", "d", "e"]);
  });

  it("applies the token budget (cuts older messages first)", () => {
    // Each "x".repeat(80) → JSON.stringify cost ≈ 84 chars → ~21 tokens.
    const newestFirst = [
      msg("newest", "x".repeat(80)),
      msg("mid", "x".repeat(80)),
      msg("oldest", "x".repeat(80)),
    ];
    // Budget fits 2 of 3.
    const r = selectHistoryWindow(newestFirst, { limitMessages: 100, budgetTokens: 50 });
    expect(r.map((m) => m.id)).toEqual(["mid", "newest"]);
  });

  it("keeps the newest message even when it alone exceeds the budget", () => {
    const huge = "y".repeat(8000);
    const newestFirst = [msg("only", huge)];
    const r = selectHistoryWindow(newestFirst, { limitMessages: 100, budgetTokens: 10 });
    expect(r.map((m) => m.id)).toEqual(["only"]);
  });

  it("returns empty when the input is empty", () => {
    const r = selectHistoryWindow([], { limitMessages: 100, budgetTokens: 1_000 });
    expect(r).toEqual([]);
  });

  it("count cap is applied before the token walk (oldest beyond cap are not considered)", () => {
    // 5 small messages + cap 2; oldest 3 should be untouched by budget logic.
    const newestFirst = [msg("e"), msg("d"), msg("c"), msg("b"), msg("a")];
    const r = selectHistoryWindow(newestFirst, { limitMessages: 2, budgetTokens: 1_000_000 });
    expect(r.map((m) => m.id)).toEqual(["d", "e"]);
  });
});
