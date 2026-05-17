import { GoogleGenAI, type FunctionCall } from "@google/genai";
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { REGISTRY } from "./tools/index.js";
import { dispatchTool } from "./dispatcher.js";
import { toGeminiFunctionDeclarations } from "./gemini-adapter.js";
import { buildFinancialContext } from "./context.js";
import { selectHistoryWindow } from "./history-window.js";
import type { ToolContext } from "./tools/types.js";
import type { Role } from "@fina/shared";

const SYSTEM_PROMPT = `You are Fina, a personal-finance assistant for Canadian users. You help users
understand their spending, categorize transactions, and plan their budgets.

Style:
- Concise. Short sentences. No bullet lists unless asked.
- Use Korean if the user writes in Korean; otherwise English.
- Currency is CAD unless stated.

When you need data, call a tool. Don't make up transactions, balances, or categories.
When a tool returns { error: ... }, briefly explain the issue and suggest what to try.

Don't ask permission to look up data — just call the tool and show the result.

For write tools (createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘' or 'Starbucks를 Coffee 카테고리로 자동분류' or 'Netflix를 매월 19달러 정기지출로 추가, 다음 결제 2026-06-01'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?' or '식비 예산 줄여야 할까?' or 'Starbucks 카테고리 어디로 할까?' or '구독 정리 좀 해줄까?'`;

export type ToolCallRecord = {
  toolName: string;
  args: unknown;
  result: { output: unknown } | { error: string };
};

type TextBlock = { type: "text"; markdown: string };
type ToolBlock = { type: "tool"; toolName: string; args: unknown; result: unknown };
type Block = TextBlock | ToolBlock;

type GeminiContent = {
  role: "user" | "model";
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } }
  >;
};

export function toGeminiHistory(messages: Array<{ role: string; blocks: unknown }>): GeminiContent[] {
  const out: GeminiContent[] = [];
  for (const m of messages) {
    const blocks = m.blocks as Block[];
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: (blocks[0] as TextBlock).markdown }] });
      continue;
    }
    if (m.role === "assistant") {
      out.push({ role: "model", parts: [{ text: (blocks[0] as TextBlock).markdown }] });
      continue;
    }
    const t = blocks[0] as ToolBlock;
    const isError = t.result && typeof t.result === "object" && "error" in (t.result as object);
    const response = isError ? (t.result as { error: string }) : (t.result as { output: unknown });
    out.push({ role: "model", parts: [{ functionCall: { name: t.toolName, args: (t.args as Record<string, unknown>) ?? {} } }] });
    out.push({ role: "user", parts: [{ functionResponse: { name: t.toolName, response: response as Record<string, unknown> } }] });
  }
  // Drop leading entries that Gemini would reject:
  // - role "model" (assistant or tool functionCall) without preceding user text
  // - role "user" but a functionResponse with no matching functionCall (happens when
  //   history was trimmed and a tool row was kept while the user that triggered it was cut)
  while (out.length > 0) {
    const head = out[0]!;
    const firstPart = head.parts[0];
    const isUserText = head.role === "user" && firstPart != null && !("functionResponse" in firstPart);
    if (isUserText) break;
    out.shift();
  }
  return out;
}

export async function processChatTurn(
  env: Env,
  thread: { id: string; workspaceId: string },
  userId: string,
  role: Role,
): Promise<{ assistantText: string; toolCalls: ToolCallRecord[] }> {
  const HISTORY_LIMIT_MESSAGES = env.CHAT_HISTORY_LIMIT_MESSAGES ?? 200;
  const HISTORY_BUDGET_TOKENS = env.CHAT_HISTORY_BUDGET_TOKENS ?? 400_000;
  const MAX_TOOL_CALLS = env.CHAT_MAX_TOOL_CALLS_PER_TURN ?? 10;
  const MODEL = env.CHAT_MODEL ?? "gemini-2.5-flash-lite";

  const toolCtx: ToolContext = { env, workspaceId: thread.workspaceId, userId, role };

  const recent = await prisma.chatMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT_MESSAGES,
  });
  const historyChrono = selectHistoryWindow(recent, {
    limitMessages: HISTORY_LIMIT_MESSAGES,
    budgetTokens: HISTORY_BUDGET_TOKENS,
  });

  const sysInstruction = `${SYSTEM_PROMPT}\n\n${await buildFinancialContext(thread.workspaceId)}`;
  const tools = [{ functionDeclarations: toGeminiFunctionDeclarations(REGISTRY) }];

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  let contents = toGeminiHistory(historyChrono);
  if (contents.length === 0) throw new Error("chat_history_empty");

  const toolCalls: ToolCallRecord[] = [];
  let dispatched = 0;

  while (true) {
    const resp = await ai.models.generateContent({ model: MODEL, contents, config: { systemInstruction: sysInstruction, tools } });

    const fcs: FunctionCall[] = resp.functionCalls ?? [];
    if (fcs.length === 0) return { assistantText: resp.text ?? "", toolCalls };

    if (dispatched + fcs.length > MAX_TOOL_CALLS) {
      console.warn("chat: max tool calls exceeded", { threadId: thread.id, dispatched, requested: fcs.length });
      return { assistantText: "I couldn't complete that — try a simpler request.", toolCalls };
    }

    const newContents: GeminiContent[] = [...contents];
    let dispatchedThisRound = 0;
    for (const fc of fcs) {
      if (!fc.name) { console.warn("chat: function call missing name", { threadId: thread.id }); continue; }
      const fcName = fc.name;
      const fcArgs = (fc.args ?? {}) as Record<string, unknown>;
      const dispatch = await dispatchTool(toolCtx, fcName, fcArgs, REGISTRY);
      const responseObj = dispatch.ok ? { output: dispatch.result } : { error: dispatch.error };
      toolCalls.push({ toolName: fcName, args: fcArgs, result: responseObj });
      await prisma.chatMessage.create({ data: { threadId: thread.id, role: "tool", blocks: [{ type: "tool", toolName: fcName, args: fcArgs, result: responseObj }] } });
      newContents.push(
        { role: "model", parts: [{ functionCall: { name: fcName, args: fcArgs } }] },
        { role: "user", parts: [{ functionResponse: { name: fcName, response: responseObj } }] },
      );
      dispatched++;
      dispatchedThisRound++;
    }

    if (dispatchedThisRound === 0) {
      console.warn("chat: function-call round with no dispatchable calls", { threadId: thread.id, requested: fcs.length });
      return { assistantText: "I couldn't complete that — try a simpler request.", toolCalls };
    }

    contents = newContents;
  }
}
