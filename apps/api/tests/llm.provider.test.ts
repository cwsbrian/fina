import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LIGHT_LLM_MODEL, DEFAULT_LLM_MODEL, generateLlmContent } from "../src/llm/provider.js";
import { testEnv } from "./helpers/test-env.js";

describe("generateLlmContent", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("uses DeepSeek V4 Flash as every default LLM model", () => {
    expect(DEFAULT_LLM_MODEL).toBe("deepseek-v4-flash");
    expect(DEFAULT_LIGHT_LLM_MODEL).toBe("deepseek-v4-flash");
    expect(testEnv().CHAT_MODEL).toBe("deepseek-v4-flash");
    expect(testEnv().DEEPSEEK_API_KEY).toBeTruthy();
  });

  it("routes DeepSeek V4 Flash through the OpenAI-compatible DeepSeek API", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "ok",
                tool_calls: [
                  {
                    type: "function",
                    function: {
                      name: "listCategories",
                      arguments: "{\"limit\":5}",
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 11,
            prompt_cache_hit_tokens: 4,
            prompt_cache_miss_tokens: 7,
            completion_tokens: 7,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateLlmContent(
      {
        DEEPSEEK_API_KEY: "deepseek-test",
      } as never,
      {
        model: "deepseek-v4-flash",
        systemInstruction: "system",
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "listCategories",
                description: "List categories",
                parametersJsonSchema: {
                  type: "object",
                  properties: { limit: { type: "number" } },
                },
              },
            ],
          },
        ],
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer deepseek-test",
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "listCategories",
            description: "List categories",
          },
        },
      ],
    });
    expect(result.text).toBe("ok");
    expect(result.functionCalls).toEqual([
      { name: "listCategories", args: { limit: 5 } },
    ]);
    expect(result.usageMetadata).toEqual({
      promptTokenCount: 11,
      promptCacheHitTokenCount: 4,
      promptCacheMissTokenCount: 7,
      candidatesTokenCount: 7,
    });
  });

  it("rejects non-DeepSeek model overrides", async () => {
    await expect(
      generateLlmContent(
        { DEEPSEEK_API_KEY: "deepseek-test" } as never,
        {
          model: "legacy-non-deepseek-model",
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        },
      ),
    ).rejects.toThrow(/DeepSeek models only/);
  });
});
