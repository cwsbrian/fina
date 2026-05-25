// ── Categorize mock (existing — DO NOT CHANGE the shape; callers depend on it) ──

type CategorizeResponse =
  | { results: Array<{ tx_id: string; category: string }> }
  | Error
  | Promise<{ results: Array<{ tx_id: string; category: string }> } | Error>;

export const geminiMock = {
  generateContent: [] as CategorizeResponse[],
};

let _lastCategorizeRequest: unknown = null;
export function lastGeminiRequest(): unknown {
  return _lastCategorizeRequest;
}

export function resetGeminiMock(): void {
  geminiMock.generateContent.length = 0;
  chatGeminiMock.responses.length = 0;
  _lastCategorizeRequest = null;
}

function popCategorize(): CategorizeResponse {
  const next = geminiMock.generateContent.shift();
  if (!next) throw new Error("Gemini mock has no scripted response; test forgot to push one");
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
  if (!next) throw new Error("Chat Gemini mock has no scripted response; test forgot to push one");
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

export function geminiMockFactory() {
  return {
    GoogleGenAI: class {
      constructor(_: unknown) {}
      models = { generateContent };
    },
    Type: { OBJECT: "object", ARRAY: "array", STRING: "string", NUMBER: "number", BOOLEAN: "boolean" },
  };
}
