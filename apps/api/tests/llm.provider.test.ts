import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LIGHT_LLM_MODEL,
  DEFAULT_LLM_MODEL,
  generateLlmContent,
  llmPromptCacheKey,
} from "../src/llm/provider.js";
import { testEnv } from "./helpers/test-env.js";

describe("generateLlmContent", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("uses GPT-5 Nano as every default LLM model", () => {
    expect(DEFAULT_LLM_MODEL).toBe("gpt-5-nano");
    expect(DEFAULT_LIGHT_LLM_MODEL).toBe("gpt-5-nano");
    expect(testEnv().CHAT_MODEL).toBe("gpt-5-nano");
    expect(testEnv().OPENAI_API_KEY).toBeTruthy();
  });

  it("routes GPT-5 Nano through OpenAI with prompt-cache accounting", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: "ok",
                tool_calls: [
                  {
                    type: "function",
                    function: { name: "listCategories", arguments: "{\"limit\":5}" },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 11,
            prompt_tokens_details: { cached_tokens: 4 },
            completion_tokens: 7,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateLlmContent(
      { OPENAI_API_KEY: "openai-test" } as never,
      {
        model: "gpt-5-nano",
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
        forceTool: "listCategories",
        maxOutputTokens: 100,
        temperature: 0.7,
        promptCacheKey: "fina:chat:test",
      },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer openai-test" }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      model: "gpt-5-nano",
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "hello" },
      ],
      reasoning_effort: "minimal",
      max_completion_tokens: 100,
      prompt_cache_key: "fina:chat:test",
      tool_choice: {
        type: "function",
        function: { name: "listCategories" },
      },
    });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("max_tokens");
    expect(result).toMatchObject({
      text: "ok",
      functionCalls: [{ name: "listCategories", args: { limit: 5 } }],
      usageMetadata: {
        promptTokenCount: 11,
        promptCacheHitTokenCount: 4,
        promptCacheMissTokenCount: 7,
        candidatesTokenCount: 7,
      },
    });
  });

  it("builds stable cache keys without exposing the raw thread id", () => {
    const first = llmPromptCacheKey("chat", "thread-secret-id");
    expect(first).toBe(llmPromptCacheKey("chat", "thread-secret-id"));
    expect(first).not.toContain("thread-secret-id");
    expect(first).not.toBe(llmPromptCacheKey("chat", "another-thread"));
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
        forceTool: "listCategories",
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
      tool_choice: {
        type: "function",
        function: { name: "listCategories" },
      },
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

  it("rejects unsupported model overrides", async () => {
    await expect(
      generateLlmContent(
        { DEEPSEEK_API_KEY: "deepseek-test" } as never,
        {
          model: "legacy-non-deepseek-model",
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        },
      ),
    ).rejects.toThrow(/Unsupported LLM model/);
  });
});
