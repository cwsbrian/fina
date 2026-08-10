import { afterEach, describe, expect, it, vi } from "vitest";

import { callLlmCategorize } from "../src/categorize/llm.js";

describe("callLlmCategorize", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("includes the word JSON when requesting DeepSeek JSON mode", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "{\"results\":[]}" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callLlmCategorize(
      { DEEPSEEK_API_KEY: "deepseek-test", CHAT_MODEL: "deepseek-v4-flash" } as never,
      { expense: ["Other"], income: ["Other"] },
      [],
      null,
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
      response_format?: { type: string };
    };
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages.map((m) => m.content).join("\n")).toMatch(/json/i);
  });

  it("accepts DeepSeek responses that use transactions instead of results", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  "{\"transactions\":[{\"tx_id\":\"tx_1\",\"category\":\"Groceries\"}]}",
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      callLlmCategorize(
        { DEEPSEEK_API_KEY: "deepseek-test", CHAT_MODEL: "deepseek-v4-flash" } as never,
        { expense: ["Groceries"], income: ["Other"] },
        [{ id: "tx_1", merchantRaw: "Loblaws", amount: 10, occurredAtISO: "2026-06-01" }],
        null,
      ),
    ).resolves.toEqual([{ tx_id: "tx_1", category: "Groceries" }]);
  });
});
