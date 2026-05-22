import { describe, expect, it, vi, beforeEach } from "vitest";
import { briefBlocksToText } from "../src/chat/brief.js";

// Mock Gemini at the top — must be hoisted before any module that imports it.
vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: {
      generateContent: vi.fn().mockResolvedValue({
        text: "좋은 아침! 어제 Starbucks 한 건 분류 필요해. 오늘 시장 $100 잡혀있어.",
      }),
    },
  })),
}));

beforeEach(() => vi.clearAllMocks());

describe("briefBlocksToText", () => {
  it("returns empty string for non-array", () => {
    expect(briefBlocksToText(null)).toBe("");
    expect(briefBlocksToText({})).toBe("");
  });

  it("extracts and joins text blocks", () => {
    const blocks = [
      { type: "text", markdown: "Hello" },
      { type: "text", markdown: "World" },
    ];
    expect(briefBlocksToText(blocks)).toBe("Hello\nWorld");
  });

  it("skips non-text blocks", () => {
    const blocks = [
      { type: "text", markdown: "Keep" },
      { type: "confirm_card", payload: {} },
      { type: "text", markdown: "Also keep" },
    ];
    expect(briefBlocksToText(blocks)).toBe("Keep\nAlso keep");
  });

  it("truncates to 1000 chars", () => {
    const blocks = [{ type: "text", markdown: "x".repeat(2000) }];
    expect(briefBlocksToText(blocks)).toHaveLength(1000);
  });
});

describe("generateBrief (mocked LLM)", () => {
  it("emits a single text PresentationBlock from Gemini's response", async () => {
    const { generateBrief } = await import("../src/chat/brief.js");
    const { testEnv } = await import("./helpers/test-env.js");

    const blocks = await generateBrief(
      testEnv(),
      {
        user: { id: "u1", name: "Brian", tz: "America/Toronto", morningTime: "08:00" },
        briefType: "daily",
        date: "2026-05-22",
        workspaces: [{
          id: "ws1",
          name: "Personal",
          currency: "CAD",
          newTransactions: { count: 1, sample: [{ merchant: "Starbucks", amount: "10.00", occurredAt: "2026-05-21T15:00:00Z", category: null }] },
          uncategorizedCount: 1,
          schedule: [{ category: "시장", amount: "100", date: "2026-05-22" }],
          budgets: [],
          recurring: [],
          deviation: null,
        }],
      },
      [],
      "daily",
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect((blocks[0] as { markdown: string }).markdown).toContain("Starbucks");
  });

  it("falls back to encouragement when LLM returns empty", async () => {
    const mod = await import("@google/genai");
    vi.mocked(mod.GoogleGenAI).mockImplementationOnce(() => ({
      models: {
        generateContent: vi.fn().mockResolvedValue({ text: "" }),
      },
    }) as unknown as InstanceType<typeof mod.GoogleGenAI>);

    const { generateBrief } = await import("../src/chat/brief.js");
    const { testEnv } = await import("./helpers/test-env.js");

    const blocks = await generateBrief(
      testEnv(),
      { user: { id: "u1", name: null, tz: "America/Toronto", morningTime: "08:00" }, briefType: "daily", date: "2026-05-22", workspaces: [] },
      [],
      "daily",
    );

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { markdown: string }).markdown).toContain("좋은 아침");
  });
});
