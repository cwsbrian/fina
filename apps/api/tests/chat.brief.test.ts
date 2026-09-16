import { describe, expect, it, vi, beforeEach } from "vitest";
import { briefBlocksToText, EMPTY_BRIEF_FALLBACK } from "../src/chat/brief.js";
import { chatGeminiMock, lastChatLlmRequest, resetGeminiMock } from "./helpers/gemini-mock.js";

vi.mock("../src/llm/budget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm/budget.js")>();
  return {
    ...actual,
    logLlmCall: vi.fn(async () => {}),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  resetGeminiMock();
});

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
  it.each(["daily", "weekly"] as const)("rejects daily context before any LLM call, even with type=%s", async (briefType) => {
    const { generateBrief } = await import("../src/chat/brief.js");
    const { testEnv } = await import("./helpers/test-env.js");
    chatGeminiMock.responses.push({ text: "must not be consumed" });
    await expect(generateBrief(testEnv(), {
      user: { id: "u1", name: null, tz: "UTC", morningTime: "08:00", locale: "en-CA" },
      briefType: "daily", date: "2026-09-16", workspaces: [],
    }, [], briefType)).rejects.toThrow("daily_brief_llm_forbidden");
    expect(chatGeminiMock.responses).toHaveLength(1);
  });
  it("emits a single text PresentationBlock from the LLM response", async () => {
    const { generateBrief } = await import("../src/chat/brief.js");
    const { testEnv } = await import("./helpers/test-env.js");
    chatGeminiMock.responses.push({
      text: "Good morning! Your Starbucks charge from yesterday needs categorizing. $100 is scheduled for groceries today.",
    });

    const blocks = await generateBrief(
      testEnv(),
      {
        user: { id: "u1", name: "Brian", tz: "America/Toronto", morningTime: "08:00", locale: "en-CA" },
        briefType: "weekly",
        date: "2026-05-22",
        workspaces: [
          {
            id: "ws1",
            name: "Personal",
            briefLabel: "Personal",
            currency: "CAD",
            newTransactions: {
              count: 1,
              sample: [
                {
                  merchant: "Starbucks",
                  amount: "10.00",
                  occurredAt: "2026-05-21T15:00:00Z",
                  category: null,
                },
              ],
            },
            uncategorizedCount: 1,
            schedule: [{ category: "시장", amount: "100", date: "2026-05-22" }],
            budgets: [],
            recurring: [],
            budgetTotal: null,
            forecast: {
              mention: true,
              daysLeft: 10,
              hasHistory: false,
              portfolio: null,
              topRisks: [],
              historicalPatterns: [],
            },
          },
        ],
      },
      [],
      "weekly",
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("text");
    expect((blocks[0] as { markdown: string }).markdown).toContain("Starbucks");
  });

  it("passes recent_briefs through to the LLM (anti-repetition input)", async () => {
    const { generateBrief } = await import("../src/chat/brief.js");
    const { testEnv } = await import("./helpers/test-env.js");
    chatGeminiMock.responses.push({ text: "Brief body." });

    await generateBrief(
      testEnv(),
      {
        user: { id: "u1", name: "Brian", tz: "America/Toronto", morningTime: "08:00", locale: "en-CA" },
        briefType: "weekly",
        date: "2026-05-22",
        workspaces: [],
      },
      ["BRIEF_FROM_YESTERDAY_MARKER"],
      "weekly",
      [{ role: "user", parts: [{ text: "Háblame en español, por favor." }] }],
      "fina:brief:test",
    );

    const sentJson = JSON.stringify(lastChatLlmRequest());
    expect(sentJson).toContain("BRIEF_FROM_YESTERDAY_MARKER");
    expect(sentJson).toContain("Háblame en español, por favor.");
    expect(sentJson).toContain("latest_user_message");
    expect(sentJson).toContain("request_boundary");
    expect(sentJson).toContain("Read-only memory");
    expect(lastChatLlmRequest()).toMatchObject({ prompt_cache_key: "fina:brief:test" });
  });

  it("falls back to encouragement when LLM returns empty", async () => {
    const { generateBrief } = await import("../src/chat/brief.js");
    const { testEnv } = await import("./helpers/test-env.js");
    chatGeminiMock.responses.push({ text: "" });

    const blocks = await generateBrief(
      testEnv(),
      {
        user: { id: "u1", name: null, tz: "America/Toronto", morningTime: "08:00", locale: "en-CA" },
        briefType: "weekly",
        date: "2026-05-22",
        workspaces: [],
      },
      [],
      "weekly",
    );

    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { markdown: string }).markdown).toBe(EMPTY_BRIEF_FALLBACK);
  });
});
