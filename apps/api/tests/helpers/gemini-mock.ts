type AnyResponse =
  | { results: Array<{ tx_id: string; category: string }> }
  | Error
  | Promise<{ results: Array<{ tx_id: string; category: string }> } | Error>;

export const geminiMock = {
  generateContent: [] as AnyResponse[],
};

export function resetGeminiMock(): void {
  geminiMock.generateContent.length = 0;
}

function pop(): AnyResponse {
  const next = geminiMock.generateContent.shift();
  if (!next) {
    throw new Error("Gemini mock has no scripted response; test forgot to push one");
  }
  return next;
}

async function generateContent() {
  const next = pop();
  if (next && typeof (next as Promise<unknown>).then === "function") {
    const resolved = await (next as Promise<{ results: Array<{ tx_id: string; category: string }> } | Error>);
    if (resolved instanceof Error) throw resolved;
    return { text: JSON.stringify(resolved) };
  }
  if (next instanceof Error) throw next;
  return { text: JSON.stringify(next) };
}

export function geminiMockFactory() {
  return {
    GoogleGenAI: class {
      constructor(_: unknown) {}
      models = { generateContent };
    },
    Type: {
      OBJECT: "object",
      ARRAY: "array",
      STRING: "string",
      NUMBER: "number",
      BOOLEAN: "boolean",
    },
  };
}
