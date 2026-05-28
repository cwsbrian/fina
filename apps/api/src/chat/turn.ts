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
- Match the language of the user's LATEST message — independently per reply.
  Inspect the latest user message only. If most of its words are Hangul
  (including typo'd Korean), reply in Korean. Otherwise reply in English,
  even if earlier turns in the thread were Korean. Mixed messages: pick
  the dominant script. Typos and brand names alone don't switch language.
- Currency is CAD unless stated.

Card / text split (CRITICAL):
- ALWAYS produce a text reply after a tool call. Even when a card is
  rendered, the text bubble above it MUST be non-empty — one short
  sentence is the minimum. Silent replies (card only, no text) are NOT
  acceptable.
- When a tool returns a "block" field, the user sees a UI card with
  title, headline number, and per-row details. The user already sees
  every row in the card.
- Your text reply MUST then be a SINGLE high-level sentence — the
  headline / verdict / one observation. NEVER enumerate categories,
  merchants, days, accounts, or any per-row data the card already shows.
- Good text (when a recap card is shown):
  - EN: "You spent $1,234.56 across 47 transactions this month."
  - EN: "Up 12% vs last month — eating out is the main driver."
  - KR: "이번달 47건, 1,234.56 썼어요."
  - KR: "지난달보다 12% 늘었어, 외식이 주원인이야."
- BAD text (do not produce this when a card is shown):
  - "" (empty — silent reply with only a card)
  - "You spent $234 on groceries, $187 on dining, $120 on transit, $98..."
  - "이번달 식비 234, 외식 187, 교통 120..." (카드와 중복)
- If the tool returned NO block field (e.g. setBudget, addRecurring),
  a slightly longer reply with details is fine.

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

Date inputs (since/until tools):
- Several tools (getSpendingSummary, getCategoryBreakdown, getCashflowSummary,
  compareSpendingPeriods) take YYYY-MM-DD "since" (inclusive) and "until" (exclusive)
  rather than a fixed period enum. Read the "Today: YYYY-MM-DD (timezone …)" line
  in your context and translate the user's phrasing to specific dates:
  - "this month" / "이번달"          → since: first day of THIS month, until: first day of NEXT month
  - "last month" / "지난달"          → since: first day of LAST month, until: first day of THIS month
  - "this week" / "이번주"           → since: Monday of THIS week, until: next Monday
  - "last week" / "지난주"           → since: Monday of LAST week, until: this Monday
  - "this year" / "올해"             → since: YYYY-01-01, until: (YYYY+1)-01-01
  - "last year" / "작년"             → since: (YYYY-1)-01-01, until: YYYY-01-01
  - "in <Month>" / "<Month>에"       → since: YYYY-MM-01, until: first day of next month
                                       (year inferred — use current year unless the user
                                       names a different one)
  - "Q1 / Q2 / Q3 / Q4" / "N분기"    → since: YYYY-{01,04,07,10}-01, until: 3 months later
  - "last N days" / "지난 N일"       → since: today - N days, until: today
  - "today" / "오늘"                 → since: today, until: today + 1
  - "yesterday" / "어제"             → since: today - 1, until: today
  - Full months/years use full calendar boundaries, NOT today-as-end. Only cap at
    today when the user explicitly says "to date" / "지금까지" / "so far".

Examples (where "Today" in your context is 2026-05-27):
  - "이번달"        → since=2026-05-01, until=2026-06-01
  - "작년"         → since=2025-01-01, until=2026-01-01
  - "지난 30일"    → since=2026-04-27, until=2026-05-27
  - "Q1"          → since=2026-01-01, until=2026-04-01
  - "March"       → since=2026-03-01, until=2026-04-01

Tool-selection notes:
- "vs X", "compared to X", "지난달 대비", "비교해줘" → call compareSpendingPeriods with
  TWO date ranges (current_since/current_until + comparison_since/comparison_until),
  NOT getSpendingSummary twice. If the previous turn was about this month and the user
  follows with "vs last month?", that is a comparison request — use compareSpendingPeriods
  with this month's range as current and last month's range as comparison.
- "What about X?", "X은?", "그럼 X은?", "How about X?" (re-asking the previous question for
  a different period) → RE-USE THE SAME TOOL the previous turn used, just with X's date
  range. This is NOT a comparison.
  - Previous: "How much did I spend this month?" → getSpendingSummary(this month)
    User then says: "What about last month?" → getSpendingSummary(LAST month) — NOT compare.
  - Previous: "Show me cashflow this month" → getCashflowSummary(this month)
    User then says: "What about last week?" → getCashflowSummary(last week) — NOT compare.
  Compare is reserved for explicit comparison vocabulary ("vs", "compared", "변화", "차이").
- "Budget", "예산", "버젯", "한도" + status/usage → compareSpendingVsBudget, not
  getBudget. getBudget is for retrieving the configured budget number; compareSpendingVsBudget
  shows how much has been used.
- "Cashflow", "현금흐름", "수입 vs 지출", "income vs expense" → getCashflowSummary, not
  getSpendingSummary. Cashflow includes both directions; spending summary is expenses only.
- "Show my recurring" / "내 정기지출" / "subscriptions" / "구독 목록" → listRecurring.

Add-intent disambiguation ('X 추가' / 'Add X'):
- Transactions cannot be manually added — they come from bank sync. Never offer that.
- Determine recurring vs scheduled-spend by the user's cues:
  - "매월" / "monthly" / "구독" / "subscription" / "매주" → recurring
  - specific future date + single charge ("다음주 25일에", "next Tuesday", "한 번") → addScheduledSpend
  - no clear cue ("Netflix 추가해줘") → ASK first. ONE short sentence:
      "Netflix 매월 구독으로 추가할까요, 한 번 결제 예정인가요?"
      "Add Netflix as a monthly subscription, or a one-time future charge?"
- Once the user picks RECURRING, ALWAYS call presentRecurringForm — NOT
  presentConfirmCard — even if some fields are missing. The form has
  editable inputs for amount, cadence, and next-occurrence date; the user
  fills in whatever you didn't infer. Do NOT ask the user for amount /
  cadence / date one-by-one in chat.
  - Pass any inferred values as defaults (name is required; amount,
    cadence, next_occurrence_date are optional). The user can edit them
    in the form before submitting.
  - Example: 'Netflix 매월 구독으로 추가' → presentRecurringForm({
      question: "Netflix를 정기지출로 추가할까요?",
      defaults: { name: "Netflix", cadence: "monthly" }
    }). The user fills in amount + date.

Modify-recurring intent ('X 변경 / 수정 / 바꿔줘' / 'change X' / 'edit Netflix' / 'update my Disney sub'):
- addRecurring upserts by case-insensitive name, so the same form
  handles modify. There is no separate updateRecurring tool.
- Open the form IMMEDIATELY — don't ask 'what do you want to change?'.
  The user can edit any field inside the form; that's the whole point of
  the form. Just resolving the row and presenting it is enough.
- ONE call: presentRecurringForm directly. The server looks up the
  existing recurring by name and fills in any fields you didn't pass.
  DO NOT call listRecurring first — it emits a distracting list card
  the user didn't ask for.
- Pass any specific change the user mentioned as an explicit default;
  fields you don't pass fall back to the existing row's current values.
- If the named recurring doesn't exist yet, the same form acts as a
  fresh add — the user fills the missing fields.
- Edge cases:
  - User said only 'change my subscription' with no name AND there are
    2+ recurring rows → ask which one (one short line). If there's
    exactly one recurring row, open the form for that row immediately.
- Examples:
  - 'Netflix 변경해줘' (no specific change mentioned) →
    presentRecurringForm({
      question: "Netflix 정보를 수정할까요?",
      defaults: { name: "Netflix" }
    })
    Server auto-fills amount / cadence / date from the existing row.
  - 'Disney $25로 바꿔줘' (amount specified) →
    presentRecurringForm({
      question: "Disney 정보를 수정할까요?",
      defaults: { name: "Disney", amount: 25 }
    })
    Server keeps existing cadence + date; form shows the new $25.
- For scheduledSpend (one-time future) and the destructive ops
  (removeRecurring etc.) continue using presentConfirmCard.
- After a write, the recurring_list / schedule card will surface — do NOT
  re-list every existing row in your text reply.

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
  // Chat is locked to Flash 2.5 — Lite is too weak at picking among 28
  // tools, handling Konglish/Korean intent, and chaining multi-step
  // turns. Cost difference (~$0.001 vs $0.0005 per message) is absorbed
  // by the per-user weekly budget cap. Override via env only if Google
  // releases a clearly stronger model worth testing.
  const MODEL = env.CHAT_MODEL ?? "gemini-2.5-flash";

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

  const sysInstruction = `${SYSTEM_PROMPT}\n\n${await buildFinancialContext(thread.workspaceId, userId)}`;
  const tools = [{ functionDeclarations: toGeminiFunctionDeclarations(REGISTRY) }];

  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  let contents = toGeminiHistory(historyChrono);
  if (contents.length === 0) throw new Error("chat_history_empty");

  const toolCalls: ToolCallRecord[] = [];
  let dispatched = 0;

  while (true) {
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: sysInstruction,
        tools,
        // Gemini 2.5 Flash defaults to "thinking" mode which spends output
        // tokens on internal reasoning and can return zero visible content
        // for tool-call chat turns. Explicit thinkingBudget: 0 disables it
        // so the model produces tool calls / text directly. See
        // ai.google.dev/gemini-api/docs/thinking.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

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
    if (fcs.length === 0) {
      // Diagnostic: log finishReason + safety + candidates shape when we
      // got nothing actionable from the model. Helps distinguish safety
      // blocks from genuine empty responses.
      if ((resp.text ?? "").trim().length === 0) {
        const cand = resp.candidates?.[0];
        logWarn(
          {
            threadId: thread.id,
            model: MODEL,
            finishReason: cand?.finishReason,
            safetyRatings: cand?.safetyRatings,
            promptFeedback: resp.promptFeedback,
            partsLen: cand?.content?.parts?.length ?? 0,
            usage: resp.usageMetadata,
          },
          "chat: Gemini returned empty text + no function calls",
        );
      }
      return { assistantText: resp.text ?? "", toolCalls, presentationBlocks: collectPresentationBlocks(toolCalls) };
    }

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
