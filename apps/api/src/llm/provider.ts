import { createHash } from "node:crypto";

import type { Env } from "../env.js";

export const DEFAULT_LLM_MODEL = "gpt-5-nano";
export const DEFAULT_LIGHT_LLM_MODEL = "gpt-5-nano";

export type LlmPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } };

export type LlmContent = {
  role: "user" | "model";
  parts: LlmPart[];
};

export type LlmTool = {
  functionDeclarations: Array<{
    name?: string;
    description?: string;
    parametersJsonSchema?: unknown;
  }>;
};

export type LlmGenerateArgs = {
  model: string;
  contents: LlmContent[];
  systemInstruction?: string;
  tools?: LlmTool[];
  responseMimeType?: string;
  responseSchema?: unknown;
  maxOutputTokens?: number;
  temperature?: number;
  thinkingBudget?: number;
  forceTool?: string;
  promptCacheKey?: string;
};

export type LlmGenerateResponse = {
  text?: string;
  functionCalls?: Array<{ name?: string; args?: Record<string, unknown> }>;
  usageMetadata?: {
    promptTokenCount?: number;
    promptCacheHitTokenCount?: number;
    promptCacheMissTokenCount?: number;
    candidatesTokenCount?: number;
  };
  candidates?: unknown[];
  promptFeedback?: unknown;
};

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export async function generateLlmContent(
  env: Env,
  args: LlmGenerateArgs,
): Promise<LlmGenerateResponse> {
  if (isOpenAIModel(args.model)) return generateOpenAI(env, args);
  if (isDeepSeekModel(args.model)) return generateDeepSeek(env, args);
  throw new Error(`Unsupported LLM model: ${args.model}`);
}

function isOpenAIModel(model: string): boolean {
  return model.startsWith("gpt-");
}

function isDeepSeekModel(model: string): boolean {
  return model.startsWith("deepseek-");
}

/** Stable, privacy-preserving key for routing related prompts to the same cache. */
export function llmPromptCacheKey(scope: string, id: string): string {
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 32);
  return `fina:${scope}:${digest}`;
}

async function generateOpenAI(
  env: Env,
  args: LlmGenerateArgs,
): Promise<LlmGenerateResponse> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for OpenAI models");
  }

  const body: Record<string, unknown> = {
    model: args.model,
    messages: toOpenAIMessages(args),
    stream: false,
    reasoning_effort: "minimal",
  };
  const tools = toOpenAITools(args.tools);
  if (tools.length > 0) body.tools = tools;
  if (args.forceTool) {
    body.tool_choice = { type: "function", function: { name: args.forceTool } };
  }
  if (args.responseMimeType === "application/json") {
    body.response_format = { type: "json_object" };
  }
  if (args.maxOutputTokens) body.max_completion_tokens = args.maxOutputTokens;
  if (args.promptCacheKey) body.prompt_cache_key = args.promptCacheKey;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 300)}`);
  }
  const json = (await response.json()) as OpenAIChatCompletionResponse;
  return fromOpenAIResponse(json);
}

async function generateDeepSeek(
  env: Env,
  args: LlmGenerateArgs,
): Promise<LlmGenerateResponse> {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required for DeepSeek models");
  }

  const body: Record<string, unknown> = {
    model: args.model,
    messages: toOpenAIMessages(args),
    stream: false,
    thinking: { type: "disabled" },
  };
  const tools = toOpenAITools(args.tools);
  if (tools.length > 0) body.tools = tools;
  if (args.forceTool) {
    body.tool_choice = { type: "function", function: { name: args.forceTool } };
  }
  if (args.responseMimeType === "application/json") {
    body.response_format = { type: "json_object" };
  }
  if (args.maxOutputTokens) body.max_tokens = args.maxOutputTokens;
  if (typeof args.temperature === "number") body.temperature = args.temperature;

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`DeepSeek API error ${response.status}: ${text.slice(0, 300)}`);
  }
  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: {
      prompt_tokens?: number;
      prompt_cache_hit_tokens?: number;
      prompt_cache_miss_tokens?: number;
      completion_tokens?: number;
    };
  };
  const message = json.choices?.[0]?.message;
  const usage = json.usage;
  const functionCalls = message?.tool_calls?.map((tc) => ({
    ...(tc.function?.name ? { name: tc.function.name } : {}),
    args: parseToolArgs(tc.function?.arguments),
  }));
  return {
    ...(typeof message?.content === "string" ? { text: message.content } : {}),
    ...(functionCalls ? { functionCalls } : {}),
    usageMetadata: {
      promptTokenCount: usage?.prompt_tokens ?? 0,
      ...(typeof usage?.prompt_cache_hit_tokens === "number"
        ? { promptCacheHitTokenCount: usage.prompt_cache_hit_tokens }
        : {}),
      ...(typeof usage?.prompt_cache_miss_tokens === "number"
        ? { promptCacheMissTokenCount: usage.prompt_cache_miss_tokens }
        : {}),
      candidatesTokenCount: usage?.completion_tokens ?? 0,
    },
  };
}

type OpenAIChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens?: number;
  };
};

function fromOpenAIResponse(json: OpenAIChatCompletionResponse): LlmGenerateResponse {
  const message = json.choices?.[0]?.message;
  const usage = json.usage;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cacheHitTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const functionCalls = message?.tool_calls?.map((tc) => ({
    ...(tc.function?.name ? { name: tc.function.name } : {}),
    args: parseToolArgs(tc.function?.arguments),
  }));
  return {
    ...(typeof message?.content === "string" ? { text: message.content } : {}),
    ...(functionCalls ? { functionCalls } : {}),
    usageMetadata: {
      promptTokenCount: promptTokens,
      promptCacheHitTokenCount: cacheHitTokens,
      promptCacheMissTokenCount: Math.max(0, promptTokens - cacheHitTokens),
      candidatesTokenCount: usage?.completion_tokens ?? 0,
    },
  };
}

function toOpenAIMessages(args: LlmGenerateArgs): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  if (args.systemInstruction) {
    messages.push({ role: "system", content: args.systemInstruction });
  }
  const pendingToolIds: string[] = [];
  let callIndex = 0;

  for (const content of args.contents) {
    const text = content.parts
      .filter((part): part is { text: string } => "text" in part)
      .map((part) => part.text)
      .join("\n");
    const functionCalls = content.parts.filter(
      (part): part is { functionCall: { name: string; args: Record<string, unknown> } } =>
        "functionCall" in part,
    );
    const functionResponses = content.parts.filter(
      (part): part is { functionResponse: { name: string; response: Record<string, unknown> } } =>
        "functionResponse" in part,
    );

    if (functionCalls.length > 0) {
      const toolCalls = functionCalls.map((part) => {
        const id = `call_${callIndex++}_${part.functionCall.name}`;
        pendingToolIds.push(id);
        return {
          id,
          type: "function" as const,
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
        };
      });
      messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls });
      continue;
    }

    if (functionResponses.length > 0) {
      for (const part of functionResponses) {
        messages.push({
          role: "tool",
          tool_call_id: pendingToolIds.shift() ?? `call_${callIndex++}_${part.functionResponse.name}`,
          content: JSON.stringify(part.functionResponse.response ?? {}),
        });
      }
      continue;
    }

    if (content.role === "model") {
      messages.push({ role: "assistant", content: text });
    } else {
      messages.push({ role: "user", content: text });
    }
  }
  return messages;
}

function toOpenAITools(tools: LlmTool[] | undefined): Array<{
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}> {
  return (tools ?? []).flatMap((tool) =>
    tool.functionDeclarations
      .filter((decl): decl is { name: string; description?: string; parametersJsonSchema?: unknown } =>
        typeof decl.name === "string" && decl.name.length > 0,
      )
      .map((decl) => ({
        type: "function" as const,
        function: {
          name: decl.name,
          ...(decl.description ? { description: decl.description } : {}),
          parameters: decl.parametersJsonSchema ?? { type: "object", properties: {} },
        },
      })),
  );
}

function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
