// ── Categorize mock (existing — DO NOT CHANGE the shape; callers depend on it) ──

type CategorizeResponse =
  | { results: Array<{ tx_id: string; category: string }> }
  | Error
  | Promise<{ results: Array<{ tx_id: string; category: string }> } | Error>;

export const geminiMock = {
  generateContent: [] as CategorizeResponse[],
};

let _lastCategorizeRequest: unknown = null;
let _lastChatRequest: unknown = null;
export function lastLlmCategorizeRequest(): unknown {
  return _lastCategorizeRequest;
}
export function lastChatLlmRequest(): unknown {
  return _lastChatRequest;
}

export function resetGeminiMock(): void {
  geminiMock.generateContent.length = 0;
  chatGeminiMock.responses.length = 0;
  _lastCategorizeRequest = null;
  _lastChatRequest = null;
  globalThis.fetch = deepSeekMockFetch as unknown as typeof fetch;
}

function popCategorize(): CategorizeResponse {
  const next = geminiMock.generateContent.shift();
  if (!next) throw new Error("LLM categorize mock has no scripted response; test forgot to push one");
  return next;
}

// ── Chat mock (new — used by chat.turn.test.ts and chat.routes.test.ts) ──

export type ChatMockRound =
  | { text: string }
  | { functionCalls: Array<{ name?: string; args?: Record<string, unknown> }> }
  | Error;

export const chatGeminiMock = {
  responses: [] as ChatMockRound[],
};

function popChat(): ChatMockRound {
  const next = chatGeminiMock.responses.shift();
  if (!next) throw new Error("Chat LLM mock has no scripted response; test forgot to push one");
  return next;
}

type GenContentReq = {
  config?: { responseSchema?: unknown };
  contents?: Array<{ role?: string; parts?: Array<{ text?: string }> }>;
};

async function generateContent(req: GenContentReq = {}) {
  const isCategorize = !!req.config?.responseSchema;
  if (isCategorize) {
    // Capture the categorize payload (JSON-stringified in contents[0].parts[0].text)
    // so tests can assert plaid_hint inclusion etc.
    const rawText = req.contents?.[0]?.parts?.[0]?.text;
    if (typeof rawText === "string") {
      try {
        _lastCategorizeRequest = JSON.parse(rawText);
      } catch {
        _lastCategorizeRequest = rawText;
      }
    } else {
      _lastCategorizeRequest = null;
    }
    const next = popCategorize();
    if (next && typeof (next as Promise<unknown>).then === "function") {
      const resolved = await (next as Promise<{ results: Array<{ tx_id: string; category: string }> } | Error>);
      if (resolved instanceof Error) throw resolved;
      return { text: JSON.stringify(resolved) };
    }
    if (next instanceof Error) throw next;
    return { text: JSON.stringify(next) };
  }
  const next = popChat();
  if (next instanceof Error) throw next;
  if ("text" in next) return { text: next.text, functionCalls: undefined };
  return { text: undefined, functionCalls: next.functionCalls };
}

async function deepSeekMockFetch(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as {
    response_format?: { type?: string };
    messages?: Array<{ role?: string; content?: string | null }>;
  } : {};
  const isCategorize = body.response_format?.type === "json_object";
  if (isCategorize) {
    const rawText = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content;
    if (typeof rawText === "string") {
      try {
        _lastCategorizeRequest = JSON.parse(rawText);
      } catch {
        _lastCategorizeRequest = rawText;
      }
    } else {
      _lastCategorizeRequest = null;
    }
    const next = popCategorize();
    if (next && typeof (next as Promise<unknown>).then === "function") {
      const resolved = await (next as Promise<{ results: Array<{ tx_id: string; category: string }> } | Error>);
      if (resolved instanceof Error) throw resolved;
      return deepSeekJsonResponse(JSON.stringify(resolved));
    }
    if (next instanceof Error) throw next;
    return deepSeekJsonResponse(JSON.stringify(next));
  }

  _lastChatRequest = body;
  const next = popChat();
  if (next instanceof Error) throw next;
  if ("text" in next) return deepSeekJsonResponse(next.text);
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            tool_calls: next.functionCalls.map((call) => ({
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.args ?? {}),
              },
            })),
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function deepSeekJsonResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

export function geminiMockFactory() {
  return {
    GoogleGenAI: class {
      constructor(_: unknown) {}
      models = { generateContent };
    },
    Type: { OBJECT: "object", ARRAY: "array", STRING: "string", NUMBER: "number", BOOLEAN: "boolean" },
  };
}
