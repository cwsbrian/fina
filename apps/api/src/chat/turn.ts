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
import type { PresentationBlock } from "./blocks.js";
import {
  AUDIT_WRITE_TOOLS,
  logAuditEvent,
  resolveTargetType,
  extractTargetId,
} from "../audit/service.js";
import { logWarn } from "../logger.js";
import { logLlmCall } from "../llm/budget.js";

const SYSTEM_PROMPT = `You are Fina, a personal-finance assistant for Canadian users. You help users
understand their spending, categorize transactions, and plan their budgets.

Style:
- Concise. Short sentences. No bullet lists unless asked.
- Use Korean if the user writes in Korean; otherwise English.
- Currency is CAD unless stated.

Scope (strict — do not negotiate around this):
- Answer ONLY questions about the user's own finances and the Fina product:
  transactions, accounts, categories, budgets, goals, recurring expenses,
  scheduled spends, balances, cashflow, and how Fina works.
- For anything else, reply with ONE short sentence in the user's language
  declining and inviting a Fina-related question. Don't elaborate. Don't
  apologize at length. Don't engage with the off-topic request even
  partially. Don't try to be helpful with general knowledge "just this once".
- Off-topic examples to decline: jokes, code help, weather, news, sports,
  movies, music, recipes, translations unrelated to a receipt, stock
  picks, investment advice, life advice unrelated to spending, opinions
  on non-financial topics, role-play, writing essays or emails not about
  the user's money.
- On-topic examples to engage: "How much did I spend on coffee?",
  "Set my food budget to 500", "Show last month's recurring charges",
  "How do budgets work in Fina?", "Why did Plaid disconnect my bank?".
- Brief greetings (hi / 안녕) are fine — reply with one friendly sentence
  and prompt for a Fina-related question.

Refusal templates (mirror the user's language; vary wording naturally,
don't repeat verbatim):
- EN: "I only help with your Fina money — anything I can pull up about
  your spending or budgets?"
- KR: "Fina에선 돈 관련 얘기만 도와드려요. 지출이나 예산 중에 살펴봐
  드릴까요?"

When you need data, call a tool. Don't make up transactions, balances, or categories.
When a tool returns { error: ... }, briefly explain the issue and suggest what to try.

Don't ask permission to look up data — just call the tool and show the result.

Tool-selection notes:
- "vs X", "compared to X", "지난달 대비", "비교해줘" → call compareSpendingPeriods, not
  getSpendingSummary twice. If the previous turn was about this_month spending and the
  user follows with "vs last month?", that is a comparison request — use
  compareSpendingPeriods(current_period: "this_month", comparison_period: "last_month").
- "Budget", "예산", "버젯", "한도" + status/usage → compareSpendingVsBudget, not
  getBudget. getBudget is for retrieving the configured budget number; compareSpendingVsBudget
  shows how much has been used.
- "Cashflow", "현금흐름", "수입 vs 지출", "income vs expense" → getCashflowSummary, not
  getSpendingSummary. Cashflow includes both directions; spending summary is expenses only.

For write tools (createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring), briefly confirm with the user before invoking unless the request is unambiguous. When you want a confirm-then-execute flow, call presentConfirmCard with \`accept_action\` set to the target tool + args — the user sees a Yes/No card and the action runs only when they tap accept. Use this for destructive ops (removeRecurring) and for changes the user might want to reconsider (e.g. tripling a budget, mapping a frequent merchant). Example unambiguous (direct call OK): '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘' or 'Starbucks를 Coffee 카테고리로 자동분류' or 'Netflix를 매월 19달러 정기지출로 추가, 다음 결제 2026-06-01'. Example needs presentConfirmCard: 'Netflix 정기지출 삭제해줘' or '식비 예산을 500→2000으로 늘려' or 'Starbucks를 다른 카테고리로 옮길까?'`;

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

const REDACTED_TOOL_ARGS = new Set(["presentConfirmCard"]);

export function redactToolCallArgs(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!REDACTED_TOOL_ARGS.has(toolName)) return args;
  const { accept_action: _drop, ...rest } = args;
  return rest;
}

export function collectPresentationBlocks(
  toolCalls: Array<{ result?: unknown }>,
): PresentationBlock[] {
  const out: PresentationBlock[] = [];
  for (const tc of toolCalls) {
    const r = tc.result;
    if (!r || typeof r !== "object") continue;
    if (!("output" in r)) continue;
    const out_ = (r as { output?: unknown }).output;
    if (!out_ || typeof out_ !== "object") continue;
    if (!("block" in out_)) continue;
    out.push((out_ as { block: PresentationBlock }).block);
  }
  return out;
}

export async function processChatTurn(
  env: Env,
  thread: { id: string; workspaceId: string },
  userId: string,
  role: Role,
): Promise<{ assistantText: string; toolCalls: ToolCallRecord[]; presentationBlocks: PresentationBlock[] }> {
  const HISTORY_LIMIT_MESSAGES = env.CHAT_HISTORY_LIMIT_MESSAGES ?? 200;
  // 16k tokens ≈ last ~150 chat messages of history. Default kept tight so a
  // single LLM call stays at ~22k input tokens worst-case (~$0.002 at Flash
  // pricing); the per-user $5/mo budget cap then translates to ~600+ msgs/wk
  // headroom. Override via env if a particular workspace needs deeper recall.
  const HISTORY_BUDGET_TOKENS = env.CHAT_HISTORY_BUDGET_TOKENS ?? 16_000;
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

    // Account every Gemini call (including multi-round tool dispatch
    // iterations) against the user's weekly LLM budget. Fire-and-forget
    // so a bookkeeping failure never aborts a chat turn — the gate at
    // the route handler ran with the pre-turn balance, so a missed log
    // only delays cap enforcement by one turn.
    void logLlmCall({
      userId,
      source: "chat",
      model: MODEL,
      inputTokens: resp.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
    }).catch(() => {});

    const fcs: FunctionCall[] = resp.functionCalls ?? [];
    if (fcs.length === 0) return { assistantText: resp.text ?? "", toolCalls, presentationBlocks: collectPresentationBlocks(toolCalls) };

    if (dispatched + fcs.length > MAX_TOOL_CALLS) {
      logWarn({ threadId: thread.id }, `chat: max tool calls exceeded (dispatched=${dispatched}, requested=${fcs.length})`);
      return { assistantText: "I couldn't complete that. Try a simpler request.", toolCalls, presentationBlocks: collectPresentationBlocks(toolCalls) };
    }

    const newContents: GeminiContent[] = [...contents];
    let dispatchedThisRound = 0;
    for (const fc of fcs) {
      if (!fc.name) { logWarn({ threadId: thread.id }, "chat: function call missing name"); continue; }
      const fcName = fc.name;
      const fcArgs = (fc.args ?? {}) as Record<string, unknown>;
      const dispatch = await dispatchTool(toolCtx, fcName, fcArgs, REGISTRY);
      if (AUDIT_WRITE_TOOLS.has(fcName) && dispatch.ok) {
        void logAuditEvent({
          workspaceId: thread.workspaceId,
          actorType: "agent",
          actorUserId: userId,
          action: fcName,
          targetType: resolveTargetType(fcName),
          targetId:   extractTargetId(fcName, dispatch.result),
          payload:    redactToolCallArgs(fcName, fcArgs),
          result:     dispatch.result,
        });
      }
      const responseObj = dispatch.ok ? { output: dispatch.result } : { error: dispatch.error };
      const redactedArgs = redactToolCallArgs(fcName, fcArgs);
      toolCalls.push({ toolName: fcName, args: redactedArgs, result: responseObj });
      await prisma.chatMessage.create({ data: { threadId: thread.id, role: "tool", blocks: [{ type: "tool", toolName: fcName, args: redactedArgs, result: responseObj }] } });
      newContents.push(
        { role: "model", parts: [{ functionCall: { name: fcName, args: fcArgs } }] },
        { role: "user", parts: [{ functionResponse: { name: fcName, response: responseObj } }] },
      );
      dispatched++;
      dispatchedThisRound++;
    }

    if (dispatchedThisRound === 0) {
      logWarn({ threadId: thread.id }, `chat: function-call round with no dispatchable calls (requested=${fcs.length})`);
      return { assistantText: "I couldn't complete that. Try a simpler request.", toolCalls, presentationBlocks: collectPresentationBlocks(toolCalls) };
    }

    contents = newContents;
  }
}
