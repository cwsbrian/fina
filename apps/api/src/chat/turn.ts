import type { Env } from "../env.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { REGISTRY } from "./tools/index.js";
import { dispatchTool } from "./dispatcher.js";
import { toLlmFunctionDeclarations } from "./llm-tool-adapter.js";
import {
  DEFAULT_LLM_MODEL,
  generateLlmContent,
  llmPromptCacheKey,
} from "../llm/provider.js";
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

type FunctionCall = { name?: string; args?: Record<string, unknown> };
type LlmCandidateDiagnostic = {
  finishReason?: unknown;
  safetyRatings?: unknown;
  content?: { parts?: unknown[] };
};

export const SYSTEM_PROMPT = `You are Fina, a personal-finance assistant for Canadian users. You help users
understand their spending, categorize transactions, and plan their budgets.

Style:
- Concise. Short sentences. No bullet lists unless asked.
- Treat "Fina" as your own assistant name; don't use possessive app-name
  wording unless the user is literally asking about app account settings.
- Never expose internal jargon to the user. Words like "tool", "function
  call", "endpoint", "schema", "intent", or "presentConfirmCard" are
  developer terms — they do NOT belong in a user-facing reply. If a
  capability is missing, phrase it in everyday language ("I can't do
  that yet", "그건 아직 지원하지 않아요") and offer the closest
  alternative. NEVER say "there is no tool to …" / "툴이 없어요" /
  "function이 없어서…" — those leak the implementation.
- Match the language of the user's LATEST message — independently per reply.
  Support every language the user writes in; never fall back to English or
  infer a reply language from account locale or earlier turns. For mixed-language
  messages, use the dominant natural language. Typos, numbers, currency symbols,
  and brand names alone do not switch languages. After a tool call, keep the
  original user-authored message as the language anchor; function responses and
  tool-result JSON are not user language and must never change the reply language.
- Map explicitly stated currency symbols to ISO 4217 codes (for example € → EUR,
  £ → GBP, ¥ → JPY; use surrounding text to distinguish ambiguous symbols such
  as $). Compare that code with "Workspace currency" in Current state.
- If the user states a DIFFERENT currency while adding a transaction, DO NOT call
  addManualTransaction and do not silently relabel the amount. Call
  presentConfirmCard with accept_action.tool
  changeWorkspaceCurrencyAndAddManualTransaction. The question must clearly say,
  in the user's latest-message language, that every existing workspace amount
  will be relabeled without exchange-rate conversion and that the new transaction
  will then be recorded. The accept_action args must include all inferred
  transaction fields, the new currency, and confirmation_text in that same
  language. Only the workspace owner can accept this change.
- If the stated currency matches Workspace currency, call addManualTransaction
  normally and pass the currency. If no currency is stated, omit it and use the
  workspace currency.

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
- EN: "I'm Fina, and I only help with money here — anything I can pull up
  about your spending or budgets?"
- EN greeting: "Want me to check anything about your spending or budget?"
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
- "Budget", "예산", "버젯", "한도" → getBudget. It renders a budget card showing each
  category's configured amount, current spend, and a progress bar — use it ONLY for "show my
  budgets" / "how am I doing on my budget" (a neutral request to SEE the budget). The card
  shows the numbers, so reply with ONE short sentence — do NOT re-list the per-category
  numbers as text.
- Forward-looking "am I okay / on track" questions → compareSpendingVsBudget, NOT getBudget.
  This covers: "am I over budget?", "on track this month?", "이번달 괜찮을까?", "내가 이번달
  괜찮을까?", "이대로 괜찮아?", "이번달 어때?", "예산 초과했어?", "예산 안에서 잘 하고 있어?".
  compareSpendingVsBudget returns per-category PACE — spend so far vs where you SHOULD be by
  today in the month — plus an on-pace / over-pace flag per category. Use it whenever the user
  asks whether they'll be FINE, not just how much they've spent. Do NOT answer an "am I okay"
  question with getBudget's total spend % — total % ignores pace and per-category risk and reads
  misleadingly low early in the month. NOT for period-vs-period comparisons (those go to
  compareSpendingPeriods).
- Answering an "am I okay / on track" question: LEAD WITH THE TOTAL. The ultimate question is
  whether they'll blow their OVERALL budget — use the portfolio total (budget, projected,
  overspend, severity) FIRST: e.g. "이대로면 월말에 전체 ~$9,300, 예산 $9,000보다 ~$300 넘겨요." /
  "전체적으론 예산 안에 들어와요 (~$8,700 예상, $300 여유)." THEN, as the "where", name the 1-2
  at_risk categories with their projected overspend (and runway day if present) — these explain
  WHERE the total is leaking, but the headline judgment is the total. Use each item's severity,
  projected, projectedOverspend, runwayDay — NOT the raw spent %. Examples for the category detail:
    EN: "Dining is heading over — at this pace you'll hit ~$580 by month-end (~$80 over),
         running out around the 24th. Everything else looks on track."
    KR: "식비가 위험해요 — 이대로면 월말에 ~$580, 약 $80 초과고 24일쯤 바닥이에요.
         나머지는 괜찮아요."
  If every category is on_track: reassure ("이번달은 예산 안에서 잘 가고 있어요." /
  "You're on track for the month."). Late in the month (small runway), phrase
  retrospectively ("you ended ~$80 over") rather than present-tense.
  insufficient_history categories: say it's too new to forecast, don't warn.
- Category forecasts come from compareSpendingVsBudget/projectMonthEnd tool results.
  Use the returned projected number as-is. Do NOT invent a higher category projection or a
  causal story from early/late-month timing patterns, "end of month" habits, or raw pace.
  If asked for the basis, say it is based on recent spending history plus money already
  spent/scheduled; do not claim "last month was $400 so this month will be $600" unless the
  tool result explicitly supports that number.
- CRITICAL — when the answer is "not okay" (total projected over, OR any at_risk/watch category),
  your reply's LAST sentence MUST be a concrete OFFER the user can say "yes" to. You are a coach,
  not a reporter — never stop at the diagnosis. Use a single offer sentence, e.g.:
    "빠듯한 쪽은 남은 예산을 며칠로 나눠서 일정을 잡아드릴 수 있어요 — 잡아드릴까요? 아니면 예산을 조정할까요?"
    "Want me to spread the rest of your dining budget into a couple of planned outings so you stay
     under — or adjust the budget?"
  This overrides the general "be concise" rule for risk answers: the offer is required.
  THEN, only if the user says yes to pacing, propose the real plan with presentScheduledSpendPlan —
  split that category's REMAINING budget (cap − spent) into a few FUTURE trips sized near its
  typicalAmount. (Never schedule more spend for a category already past its cap; for those, the
  offer is to adjust the budget or find cuts.)
- Budget-change intent disambiguation:
  - **Explicit set** — user names a category AND an amount ("set my food budget to $500",
    "식비 예산 50만원으로 해줘") → call setBudget directly.
  - **Vague / open-ended edit** — user wants to change/edit a budget but gives no specific
    amount, INCLUDING when they name a category but no number ("예산 바꾸고 싶어", "예산 수정할래",
    "change my budget", "예산 바꿔줘", "lower my dining budget", "식비 예산 줄여줘") → call getBudget
    to show the budget card, then reply with ONE short sentence telling them to tap the card
    to edit on the Budget screen. Do NOT ask for amounts turn-by-turn or invent a form.
    Example reply: "현재 예산이에요 — 카드를 탭하면 예산 화면에서 바로 수정할 수 있어요." /
    "Here's your budget — tap the card to edit it on the Budget screen."
- "Cashflow", "현금흐름", "수입 vs 지출", "income vs expense" → getCashflowSummary, not
  getSpendingSummary. Cashflow includes both directions; spending summary is expenses only.
- "Show my recurring" / "내 정기지출" / "subscriptions" / "구독 목록" → listRecurring.
- Showing transactions the user names ("Touchstone 보여줘", "자세히 보여줘", "show me the X
  transaction", "5월꺼만") → call findTransactions (merchant_query + start_date/end_date for a period
  like "5월"). It AUTOMATICALLY renders a single transaction's detail card when exactly one matches,
  or a list when several match. So NEVER ask "which one?" — just call findTransactions and let the
  card/list answer. (Use getTransactionDetails only when you already hold a specific tx_id.)

Add-intent disambiguation ('X 추가' / 'Add X'):
- Ordinary purchases are one-time manual transactions by default. Words like "bought", "spent",
  "paid", "샀어", "썼어", "결제했어", or a plain "add" request mean addManualTransaction
  unless the user explicitly says the charge repeats or is in the future.
- Use recurring ONLY for explicit repetition cues such as "monthly", "weekly", "subscription",
  "recurring", "매월", "매주", or "구독".
- Use scheduled spend ONLY when the user explicitly gives a future date or says the purchase is planned.
- Never guess that coffee, food, shopping, or another ordinary purchase is a subscription.
- If merchant and amount are known, call addManualTransaction directly. Date defaults to today, so
  do not ask for it. Category is optional; omit it when uncertain.
- If the user states the SAME currency as Workspace currency, pass it to
  addManualTransaction as an uppercase ISO 4217 code. A different currency must
  use the confirmation flow above.
- If required information is missing, ask ONE short question for only the missing merchant and/or
  amount. Example: "How much did you spend on coffee and a bagel?" Do not repeat the question in
  different words and do not ask whether it is recurring or scheduled without an explicit cue.
- Do not call budget tools or show a budget card while adding a transaction unless the user asked
  about their budget.
- After addManualTransaction succeeds, reply with one short confirmation; the transaction detail
  card already shows the merchant, amount, date, account, and category.
- addManualTransaction auto-categorizes when category_name is omitted. If its result says
  needsCategory=true, ask ONE short question for the category instead of claiming completion.
  When the user answers, call categorizeTransaction with that transaction id and category.
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

Multi-item scheduled-spend PLAN intent ('일정 잡아줘', '알아서 관리해줘', '이번달 예산 내로 맞춰줘',
'help me stay on budget', 'plan my groceries for the rest of the month'):
- A "일정/plan" is for ESSENTIALS you can't avoid — groceries(장보기), food(식비), household,
  utilities, transport. You keep needing these whether or not the budget is blown, so ALWAYS pace
  them; the goal is to spend the MINIMUM necessary for the rest of the period:
    • Still has room → schedule the needed spend within the remaining budget (cap − spent).
    • ALREADY OVER → you can't undo it, but you still have to eat: schedule a MINIMAL plan for the
      rest of the month — conservative amounts (at or BELOW typicalAmount), fewest realistic trips —
      so the overspend stops growing. Frame it as "이미 초과했지만 남은 기간 최소한으로 이만큼만 쓰면
      더는 안 벌어져요", not "you have $X left".
- DISCRETIONARY categories (shopping(쇼핑), entertainment, dining-out, hobbies) are the opposite —
  if they're tight or over, you do NOT schedule them; you ADVISE the user to ease up this month
  ("쇼핑은 이번달 좀 자제하세요"). Scheduling more discretionary spend defeats the purpose.
- BE AUTONOMOUS — when the user says "알아서" / "전체적으로" / "일정 잡아줘" WITHOUT naming a category,
  do NOT ask which category and do NOT refuse. Look at compareSpendingVsBudget yourself, pick the
  ESSENTIAL categories that are tight/at_risk, and propose ONE plan covering them ALL —
  presentScheduledSpendPlan accepts items across MULTIPLE categories in a single card. In the same
  reply, name the discretionary categories to ease up on. Comfortably on-track categories need nothing.
- PROPOSE with presentScheduledSpendPlan — specific FUTURE dates + amounts, one card, one confirm.
  NEVER call addScheduledSpendBatch directly. Don't loop addScheduledSpend.
- Only propose categories that already exist. Size each amount from typicalAmount + remaining budget;
  split the remaining sensibly across realistic trips. Dates must be after today.

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

Bulk-remove-recurring intent ('모든 구독 지워줘' / 'remove all subscriptions' /
'delete every recurring' / '구독 다 삭제'):
- Use removeAllRecurring (single tool call, no args, deletes every
  recurring expense in the workspace). NEVER iterate one-by-one with
  removeRecurring — that floods the chat with N confirmation cards.
- ALWAYS gate behind presentConfirmCard with accept_action set to
  removeAllRecurring. The confirm card MUST spell out the destructive
  scope in the user's language, e.g. accept_label "모두 삭제" /
  "Delete all", reject_label "취소" / "Cancel".
- Example: '모든 구독 지워줘' → presentConfirmCard({
    question: "정기지출을 전부 삭제할까요? 되돌릴 수 없어요.",
    accept_label: "모두 삭제", reject_label: "취소",
    accept_action: { tool: "removeAllRecurring", args: {} }
  }).

- "Goals" / "목표" / "저축 목표" / "내 목표" → listGoals. It renders a goals
  card with each goal's progress, percent bar, and D-day. NOTE: savings
  accrue AUTOMATICALLY from staying under budget in a goal's categories —
  there is NO manual deposit. Never tell the user to "add money" to a goal.
- "X 목표 자세히" / "show my Japan goal" / a specific goal by name →
  getGoalDetails with title set to a word from the name (or goal_id from a
  prior card). If it returns ambiguous=true, call listGoals to show the
  picker — do NOT ask "which one?".
- "목표 만들어/추가" / "create a goal" / "여행자금 200만원 목표" → presentGoalForm
  with whatever title/target_amount/due_date you can infer in defaults. The
  form collects the rest and submits. Goals are paid-tier features; presentGoalForm
  returns a short upgrade message for Free users.
- Edit a goal: when the user gives a specific new value ("그 목표 300만원으로
  늘려줘", "change the target to 3000") → presentConfirmCard with accept_action
  { tool: "updateGoal", args: { goal_id, target_amount, ... } }. When they want
  to edit but haven't pinned the value(s) ("그 목표 수정할래") → presentGoalForm
  with goal_id so the form pre-fills and they adjust fields.
- Archive a goal ("그 목표 보관해줘", "archive my Japan goal") →
  presentConfirmCard with accept_action { tool: "archiveGoal", args: { goal_id } }.
- Generating/editing a savings STRATEGY is screen-only — tell the user to tap
  the goal card to open the goal screen; do NOT try to generate it in chat.

For write tools (addManualTransaction, createCategory, addTransactionNote, setBudget, mapMerchantToCategory, addRecurring, removeRecurring), briefly confirm with the user before invoking unless the request is unambiguous. A manual-transaction request with merchant and amount is unambiguous and should run directly. When you want a confirm-then-execute flow, call presentConfirmCard with \`accept_action\` set to the target tool + args — the user sees a Yes/No card and the action runs only when they tap accept. Use this for destructive ops (removeRecurring) and for changes the user might want to reconsider (e.g. tripling a budget, mapping a frequent merchant). Example unambiguous (direct call OK): 'Coffee $5 this morning', '카테고리 만들어줘 — Coffee 라는 이름으로' or '식비 예산 500 달러로 설정해줘' or 'Starbucks를 Coffee 카테고리로 자동분류' or 'Netflix를 매월 19달러 정기지출로 추가, 다음 결제 2026-06-01'. Example needs presentConfirmCard: 'Netflix 정기지출 삭제해줘' or '식비 예산을 500→2000으로 늘려' or 'Starbucks를 다른 카테고리로 옮길까?'`;

export type ToolCallRecord = {
  toolName: string;
  args: unknown;
  result: { output: unknown } | { error: string };
};

type TextBlock = { type: "text"; markdown: string };
type ToolBlock = { type: "tool"; toolName: string; args: unknown; result: unknown };
type Block = TextBlock | ToolBlock;
type HistoryMessage = {
  role: string;
  blocks: unknown;
  brief?: unknown;
};

type ChatLlmContent = {
  role: "user" | "model";
  parts: Array<
    | { text: string }
    | { functionCall: { name: string; args: Record<string, unknown> } }
    | { functionResponse: { name: string; response: Record<string, unknown> } }
  >;
};

function textFromBlocks(blocks: unknown): string {
  const arr = Array.isArray(blocks) ? (blocks as Array<{ type?: unknown; markdown?: unknown }>) : [];
  const textBlock = arr.find((b) => b?.type === "text" && typeof b?.markdown === "string");
  return (textBlock?.markdown as string | undefined) ?? "";
}

function isBriefAssistantMessage(message: HistoryMessage): boolean {
  return message.role === "assistant" && message.brief != null;
}

function isUserTextMessage(message: HistoryMessage): boolean {
  return message.role === "user" && textFromBlocks(message.blocks).trim().length > 0;
}

export function toLlmHistory(messages: HistoryMessage[]): ChatLlmContent[] {
  let start = 0;
  while (start < messages.length) {
    const message = messages[start]!;
    if (isUserTextMessage(message) || isBriefAssistantMessage(message)) break;
    start++;
  }

  const out: ChatLlmContent[] = [];
  for (const m of messages.slice(start)) {
    const blocks = m.blocks as Block[];
    if (m.role === "user") {
      out.push({ role: "user", parts: [{ text: textFromBlocks(m.blocks) }] });
      continue;
    }
    if (m.role === "assistant") {
      const text = textFromBlocks(m.blocks);
      if (isBriefAssistantMessage(m) && out.length === 0) {
        out.push({
          role: "user",
          parts: [{ text: `Context from Fina's latest brief:\n${text}` }],
        });
      } else {
        out.push({ role: "model", parts: [{ text }] });
      }
      continue;
    }
    const t = blocks[0] as ToolBlock;
    const isError = t.result && typeof t.result === "object" && "error" in (t.result as object);
    const response = isError ? (t.result as { error: string }) : (t.result as { output: unknown });
    out.push({ role: "model", parts: [{ functionCall: { name: t.toolName, args: (t.args as Record<string, unknown>) ?? {} } }] });
    out.push({ role: "user", parts: [{ functionResponse: { name: t.toolName, response: response as Record<string, unknown> } }] });
  }
  // Drop leading entries that chat providers reject:
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

const MANUAL_AMOUNT_RE =
  /(?:[$€£¥₩₹₽₺₴₫₪₱฿₦₲₡₵₸]\s*\d+(?:[,.]\d{1,2})?|\d+(?:[,.]\d{1,2})?\s*(?:[$€£¥₩₹₽₺₴₫₪₱฿₦₲₡₵₸]|[a-z]{3}|dollars?|euros?|pounds?|yen|won|bucks?|달러|유로|엔|원|불)(?=\s|$|[.,!?]))/iu;
const MANUAL_QUESTION_RE =
  /[?？]|^\s*(?:how|what|when|where|why|did|do|can|could|show|find|list|얼마|보여|찾아|내역)/i;
const NON_MANUAL_TRANSACTION_RE =
  /\b(?:budget|goal|balance|income|salary|saving|transfer|deposit|refund|subscription|recurring|monthly|weekly|schedule|scheduled|plan|planned|tomorrow|next\s+(?:week|month)|upcoming)\b|예산|목표|잔액|수입|월급|저축|이체|입금|환불|구독|정기|매월|매주|예약|일정|계획|예정|내일|다음\s*(?:주|달)/i;

export function shouldForceManualTransaction(message: string): boolean {
  const text = message.trim();
  return (
    text.length > 0 &&
    text.length <= 160 &&
    MANUAL_AMOUNT_RE.test(text) &&
    !MANUAL_QUESTION_RE.test(text) &&
    !NON_MANUAL_TRANSACTION_RE.test(text)
  );
}

export async function processChatTurn(
  env: Env,
  thread: { id: string; workspaceId: string },
  userId: string,
  role: Role,
): Promise<{ assistantText: string; toolCalls: ToolCallRecord[]; presentationBlocks: PresentationBlock[] }> {
  const HISTORY_LIMIT_MESSAGES = env.CHAT_HISTORY_LIMIT_MESSAGES ?? 200;
  // 16k tokens ≈ last ~150 chat messages of history. Default kept tight so a
  // single LLM call stays at ~22k input tokens worst-case (~$0.001 at Nano
  // cache-miss pricing); the per-user weekly cap still leaves ample headroom.
  // Override via env if a particular workspace needs deeper recall.
  const HISTORY_BUDGET_TOKENS = env.CHAT_HISTORY_BUDGET_TOKENS ?? 16_000;
  const MAX_TOOL_CALLS = env.CHAT_MAX_TOOL_CALLS_PER_TURN ?? 10;
  const MODEL = env.CHAT_MODEL ?? DEFAULT_LLM_MODEL;

  const toolCtx: ToolContext = { env, workspaceId: thread.workspaceId, userId, role };
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { id: thread.workspaceId },
    select: { kind: true },
  });
  const businessBlockedTools = new Set([
    "getSpendingSummary",
    "getCategoryBreakdown",
    "compareSpendingPeriods",
    "getCashflowSummary",
    "setBudget",
    "getBudget",
    "compareSpendingVsBudget",
    "addGoal",
    "updateGoal",
    "listGoals",
    "getGoalDetails",
    "presentGoalForm",
    "archiveGoal",
    "presentConfirmCard",
    "presentRecurringForm",
    "presentScheduledSpendPlan",
  ]);
  const activeRegistry = workspace.kind === "business"
    ? REGISTRY.filter((tool) => !businessBlockedTools.has(tool.name))
    : REGISTRY;

  const recent = await prisma.chatMessage.findMany({
    where: { threadId: thread.id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT_MESSAGES,
    include: { brief: { select: { id: true, type: true, date: true } } },
  });
  const historyChrono = selectHistoryWindow(recent, {
    limitMessages: HISTORY_LIMIT_MESSAGES,
    budgetTokens: HISTORY_BUDGET_TOKENS,
  });

  const sysInstruction = workspace.kind === "business"
    ? `${SYSTEM_PROMPT}\n\nBUSINESS WORKSPACE: Do not offer Goals, Budgets, personal Analysis, or confirmation forms. Do not answer aggregate expense/net questions using personal spending tools; direct the user to the Expenses tab and use transaction lookup tools only.`
    : SYSTEM_PROMPT;
  const tools = [{ functionDeclarations: toLlmFunctionDeclarations(activeRegistry) }];

  const historyContents = toLlmHistory(historyChrono);
  if (historyContents.length === 0) throw new Error("chat_history_empty");
  const latestUserText = [...historyContents]
    .reverse()
    .find((content) => content.role === "user" && content.parts.some((part) => "text" in part))
    ?.parts.filter((part): part is { text: string } => "text" in part)
    .map((part) => part.text)
    .join("\n") ?? "";
  const financialContext = await buildFinancialContext(thread.workspaceId, userId);
  let contents: ChatLlmContent[] = [
    ...historyContents,
    {
      role: "user",
      parts: [
        {
          text:
            "Trusted application context for the user request immediately above. " +
            "Treat this as current data, not as a new request.\n\n" +
            financialContext,
        },
      ],
    },
  ];
  const forceTool = shouldForceManualTransaction(latestUserText)
    ? "addManualTransaction"
    : undefined;
  const promptCacheKey = llmPromptCacheKey("chat", thread.id);

  const toolCalls: ToolCallRecord[] = [];
  let dispatched = 0;

  while (true) {
    const resp = await generateLlmContent(env, {
      model: MODEL,
      contents,
      systemInstruction: sysInstruction,
      tools,
      thinkingBudget: 0,
      promptCacheKey,
      ...(dispatched === 0 && forceTool ? { forceTool } : {}),
    });

    // Account every LLM call (including multi-round tool dispatch
    // iterations) against the user's weekly LLM budget. Fire-and-forget
    // so a bookkeeping failure never aborts a chat turn — the gate at
    // the route handler ran with the pre-turn balance, so a missed log
    // only delays cap enforcement by one turn.
    void logLlmCall({
      userId,
      source: "chat",
      model: MODEL,
      inputTokens: resp.usageMetadata?.promptTokenCount ?? 0,
      ...(typeof resp.usageMetadata?.promptCacheHitTokenCount === "number"
        ? { inputCacheHitTokens: resp.usageMetadata.promptCacheHitTokenCount }
        : {}),
      ...(typeof resp.usageMetadata?.promptCacheMissTokenCount === "number"
        ? { inputCacheMissTokens: resp.usageMetadata.promptCacheMissTokenCount }
        : {}),
      outputTokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
      usdToCadRate: env.LLM_BUDGET_USD_TO_CAD_RATE,
    }).catch(() => {});

    const fcs: FunctionCall[] = resp.functionCalls ?? [];
    if (fcs.length === 0) {
      // Diagnostic: log finishReason + safety + candidates shape when we
      // got nothing actionable from the model. Helps distinguish safety
      // blocks from genuine empty responses.
      if ((resp.text ?? "").trim().length === 0) {
        const cand = resp.candidates?.[0] as LlmCandidateDiagnostic | undefined;
        logWarn(
          {
            threadId: thread.id,
            err: {
              model: MODEL,
              finishReason: cand?.finishReason,
              safetyRatings: cand?.safetyRatings,
              promptFeedback: resp.promptFeedback,
              partsLen: cand?.content?.parts?.length ?? 0,
              usage: resp.usageMetadata,
            },
          },
          "chat: LLM returned empty text + no function calls",
        );
      }
      return { assistantText: resp.text ?? "", toolCalls, presentationBlocks: collectPresentationBlocks(toolCalls) };
    }

    if (dispatched + fcs.length > MAX_TOOL_CALLS) {
      logWarn({ threadId: thread.id }, `chat: max tool calls exceeded (dispatched=${dispatched}, requested=${fcs.length})`);
      return { assistantText: "I couldn't complete that. Try a simpler request.", toolCalls, presentationBlocks: collectPresentationBlocks(toolCalls) };
    }

    const newContents: ChatLlmContent[] = [...contents];
    let dispatchedThisRound = 0;
    for (const fc of fcs) {
      if (!fc.name) { logWarn({ threadId: thread.id }, "chat: function call missing name"); continue; }
      const fcName = fc.name;
      const fcArgs = (fc.args ?? {}) as Record<string, unknown>;
      const dispatch = await dispatchTool(toolCtx, fcName, fcArgs, activeRegistry);
      if (AUDIT_WRITE_TOOLS.has(fcName) && dispatch.ok) {
        await logAuditEvent({
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
      await prisma.chatMessage.create({
        data: {
          threadId: thread.id,
          role: "tool",
          blocks: [
            { type: "tool", toolName: fcName, args: redactedArgs, result: responseObj },
          ] as unknown as Prisma.InputJsonValue,
        },
      });
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
