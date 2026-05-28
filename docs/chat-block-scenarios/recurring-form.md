# recurring_form_card block — chat scenarios

Inline form card for adding a recurring expense. Replaces the multi-turn
"how much? what cadence? when?" loop with editable fields the user fills
once and submits.

## Flow

1. User: "넷플릭스를 매월 추가해줘" (cadence clear, amount unclear)
2. LLM: `presentRecurringForm({ defaults: { name: "Netflix", cadence: "monthly" } })`
3. Mobile renders form with Netflix pre-filled, cadence selected as Monthly,
   amount + next date empty (user fills).
4. User edits amount → 20, picks next date → 2026-06-01.
5. Taps "Add" → POST /workspaces/:wsId/intents/:intent_id/consume with
   { overrides: { amount: 20, cadence: "monthly", next_occurrence_date: "2026-06-01" } }
6. Server merges overrides with stored defaults → addRecurring runs.
7. Form locks to "Added" state; LLM's text reply confirms the action.

---

## EN — happy paths

| User message | Expected tool |
|---|---|
| `Add Netflix as a recurring expense` | `presentRecurringForm({ defaults: { name: "Netflix" } })` |
| `Make Spotify monthly` | `presentRecurringForm({ defaults: { name: "Spotify", cadence: "monthly" } })` |
| `Add gym $45 monthly` | `presentRecurringForm({ defaults: { name: "Gym", amount: 45, cadence: "monthly" } })` |
| `Add quarterly newspaper $30` | `presentRecurringForm({ defaults: { name: "Newspaper", amount: 30 } })` — quarterly maps to yearly UI choice? actually cadence enum doesn't include quarterly; LLM should leave cadence blank and let user pick |

## KR — happy paths

| User message | Expected tool |
|---|---|
| `넷플릭스 매월 정기지출로 추가` | `presentRecurringForm({ defaults: { name: "Netflix", cadence: "monthly" } })` |
| `Spotify 추가해줘 매월 11불` | `presentRecurringForm({ defaults: { name: "Spotify", amount: 11, cadence: "monthly" } })` |
| `매주 커피 5불 추가` | `presentRecurringForm({ defaults: { name: "Coffee", amount: 5, cadence: "weekly" } })` |

## Disambiguation (asks first, then form)

| Turn 1 (user) | Turn 1 (LLM) | Turn 2 (user) | Turn 2 (LLM) |
|---|---|---|---|
| `Netflix 추가` | "Netflix 매월 구독으로 추가할까요, 한 번 결제 예정인가요?" | `구독해줘` | `presentRecurringForm({ defaults: { name: "Netflix", cadence: "monthly" } })` |
| `Add gift card` | "Add gift card as recurring, or a one-time future charge?" | `one-time, $50 next Friday` | `presentConfirmCard` → addScheduledSpend |

## Form rendering checklist

- ✅ Question line above the inputs (LLM-authored)
- ✅ Name field — read-only, shows the LLM-inferred name
- ✅ Amount input — numeric keyboard, `$` prefix, decimal validation, blocks submit on empty/zero
- ✅ Cadence — segmented pills (Monthly / Semi-mo / Biweekly / Weekly / Yearly), default Monthly if LLM didn't specify
- ✅ Next occurrence — DatePickerSheet on tap, default = today + 1 cycle
- ✅ Add button disabled until amount + date pass validation
- ✅ Submitting shows ActivityIndicator in the Add button
- ✅ Success → button text changes to "Added", form fields lock
- ✅ Cancel → form locks, intent expires naturally (1h TTL)

## Error states

| Scenario | Expected |
|---|---|
| Intent expired (>1h) before submit | Alert: "This form expired. Ask Fina to set it up again." |
| Network error mid-submit | Alert with the error code; form stays editable for retry |
| Invalid edits (amount: 0) | Add button stays disabled; no submission |

## Server-side guarantees

- `presentRecurringForm` creates an ActionIntent for `addRecurring` with
  `skipStrictValidate: true` so the partial args don't reject at create.
- `/intents/:id/consume` merges body.overrides on top of stored args
  before re-validating against addRecurring's zod schema.
- Final addRecurring args go through the same audit log as a direct call.
