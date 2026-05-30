# Chat Forecasting Advisor — Phase 3 (Plan Proposals) Implementation Plan — R2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Let the advisor propose a multi-item spending plan in chat ("groceries twice — June 3 and 10, ~$60 each?") and create all the ScheduledSpends with a single confirmation tap.

**Architecture:** A new `addScheduledSpendBatch` executor inserts N scheduled spends atomically in one workspace lock. A new `presentScheduledSpendPlan` presenter validates the items (category exists, amount is money-valid, date is in the future), creates ONE ActionIntent targeting the batch tool, and returns a `plan_proposal_card`. Reuses the existing intent → consume → audit machinery and the mobile confirm-card accept/reject flow. To let the advisor size proposals autonomously, the forecast now exposes a per-category **typicalAmount** (median tx).

**This is R2** — incorporates the multi-lens review. Changes vs R1 are flagged `[R2]`.

**Decisions (user, 2026-05-30):** direct batch calls **forbidden via prompt** (not hard-excluded); **accept/reject only** (no per-field edit in v1); **autonomous sizing** via an exposed per-category median.

**Correct commands:** api test `pnpm nx test api -- <pattern>`; mobile typecheck `pnpm nx typecheck mobile` (baseline has exactly ONE pre-existing error: `auth/client.ts:7` — the bar is "no NEW error"); shared build `pnpm nx build shared`.

---

## File Structure

| File | C/M | Responsibility |
|---|---|---|
| `libs/shared/src/dto/chat.ts` | M | `plan_proposal_card` variant |
| `apps/mobile/src/chat/blocks/PlanProposalCardBlock.tsx` | C | Card renderer (Yes/No → onAccept/onReject) |
| `apps/mobile/src/chat/PresentationBlock.tsx` | M | Dispatch `plan_proposal_card` |
| `apps/mobile/src/chat/ThreadView.tsx` | M | `[R2]` allowlist + dismissal + reject so the buttons are LIVE |
| `apps/api/src/schedules/service.ts` | M | `addScheduledSpendBatchService` (atomic N-insert) |
| `apps/api/src/budget-plans/service.ts` | M | `[R2]` `recentTypicalAmountByCategory` (median tx) |
| `apps/api/src/analysis/forecast.ts` | M | `[R2]` `CategoryForecast.typicalAmount` |
| `apps/api/src/chat/tools/_scheduled-plan-item.ts` | C | `[R2]` ONE shared item zod (kills two-copy drift) |
| `apps/api/src/chat/tools/add-scheduled-spend-batch.ts` | C | `addScheduledSpendBatch` executor |
| `apps/api/src/chat/tools/present-scheduled-spend-plan.ts` | C | `presentScheduledSpendPlan` presenter |
| `apps/api/src/chat/tools/compare-spending-vs-budget.ts` | M | `[R2]` surface `typicalAmount` on items |
| `apps/api/src/chat/tools/index.ts` | M | Register both tools |
| `apps/api/src/intents/service.ts` | M | CONFIRMABLE_TOOLS + confirmationFor case |
| `apps/api/src/audit/service.ts` | M | AUDIT_WRITE_TOOLS + TARGET_TYPE_MAP + extractTargetId |
| `apps/api/src/chat/turn.ts` | M | Prompt: propose via presenter; forbid direct batch; size from remaining+typicalAmount; future dates only |
| `apps/api/tests/chat.tools.scheduled-spend-batch.test.ts` | C | Batch + presenter + consume + rollback + past-date + bad-amount tests |

---

## Task 1 `[R2 — ATOMIC]`: `plan_proposal_card` shared block + FULL mobile wiring (one commit)

> Why atomic: adding the shared union variant breaks the mobile exhaustive renderer (`const _exhaustive: never`) until the renderer case exists, and the buttons are dead until `ThreadView` routes the block. Land all four together so `nx typecheck mobile` never goes red and the card is actually tappable.

**Files:** `libs/shared/src/dto/chat.ts`, `apps/mobile/src/chat/blocks/PlanProposalCardBlock.tsx` (create), `apps/mobile/src/chat/PresentationBlock.tsx`, `apps/mobile/src/chat/ThreadView.tsx`

- [ ] **Step 1: Shared variant** in `libs/shared/src/dto/chat.ts` (after `confirm_card`):
```ts
  | {
      /** A proposed multi-item plan (e.g. "groceries twice"). Backed by ONE
       *  ActionIntent targeting addScheduledSpendBatch; accept creates them all.
       *  Reuses confirm_card's accept/reject intent flow. */
      type: "plan_proposal_card";
      question: string;
      rows: { category: string; date: string; amount: string; note?: string }[];
      total: string; // sum of row amounts, no currency symbol
      accept_label: string;
      reject_label: string;
      accept_intent: string;
      reject_intent?: string;
    }
```

- [ ] **Step 2: Renderer** — create `apps/mobile/src/chat/blocks/PlanProposalCardBlock.tsx`. FIRST read the `confirm_card` case in `PresentationBlock.tsx` (lines ~51-79) + its `styles` to reuse the exact card/button tokens. Use `colors.onPrimary` for the accept-button text (the confirm card uses it; `colors.canvas` is near-invisible on the mint button).
```tsx
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";

type PlanCard = Extract<PresentationBlock, { type: "plan_proposal_card" }>;

export function PlanProposalCardBlock({
  block, onAccept, onReject,
}: {
  block: PlanCard;
  onAccept?: (intent: string) => void;
  onReject?: (intent: string | undefined) => void;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.question}>{block.question}</Text>
      {block.rows.map((r, i) => (
        <View key={i} style={styles.row}>
          <Text style={styles.rowLeft} numberOfLines={1}>{r.date} · {r.category}</Text>
          <Text style={styles.rowAmount}>{r.amount}</Text>
        </View>
      ))}
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalAmount}>{block.total}</Text>
      </View>
      <View style={styles.actions}>
        <Pressable style={({ pressed }) => [styles.btn, styles.reject, pressed && { opacity: 0.7 }]} onPress={() => onReject?.(block.reject_intent)}>
          <Text style={styles.rejectText}>{block.reject_label}</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [styles.btn, styles.accept, pressed && { opacity: 0.85 }]} onPress={() => onAccept?.(block.accept_intent)}>
          <Text style={styles.acceptText}>{block.accept_label}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.canvas, borderWidth: 1, borderColor: colors.hairline, borderRadius: 16, padding: space.base, marginVertical: 4, gap: space.xs },
  question: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  rowLeft: { ...type$.bodySm, color: colors.body, flex: 1, minWidth: 0 },
  rowAmount: { ...type$.bodySm, color: colors.ink, fontVariant: ["tabular-nums"] },
  totalRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: colors.hairline, paddingTop: space.xs, marginTop: 2 },
  totalLabel: { ...type$.caption, color: colors.muted, textTransform: "uppercase" },
  totalAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.xs },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 10, alignItems: "center" },
  reject: { backgroundColor: colors.hairline },
  accept: { backgroundColor: colors.primary },
  rejectText: { ...type$.bodyMd, color: colors.body, fontWeight: "600" },
  acceptText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },
});
```
(If any token name differs in `design/tokens`, use whatever the `confirm_card` case already uses — match it exactly.)

- [ ] **Step 3: Dispatch** in `PresentationBlock.tsx` — import `PlanProposalCardBlock` and add a case before the `never` cast:
```tsx
  if (block.type === "plan_proposal_card") {
    return (
      <PlanProposalCardBlock
        block={block}
        {...(onAccept ? { onAccept } : {})}
        {...(onReject ? { onReject } : {})}
      />
    );
  }
```

- [ ] **Step 4 `[R2 — the must-fix]`: ThreadView wiring** in `apps/mobile/src/chat/ThreadView.tsx` — without this the buttons are dead:
  - In `isCardBlock(b)` (line ~538-557), add `b.type === "plan_proposal_card" ||` to the allowlist (so the block gets `<PresentationBlock>` WITH `onAccept`/`onReject`).
  - In the dismissal filter (line ~623, currently `if (b.type === "confirm_card") return !dismissedIntents.has(b.accept_intent);`), broaden to also collapse a resolved plan card: `if (b.type === "confirm_card" || b.type === "plan_proposal_card") return !dismissedIntents.has(b.accept_intent);`
  - In the `onReject` handler (line ~672, `if (b.type === "confirm_card") onIntentDismissed(b.accept_intent);`), broaden likewise to `if (b.type === "confirm_card" || b.type === "plan_proposal_card")`.
  - The `onAccept` handler (line ~644) already consumes any `intentId` generically — no change. `[R2]` confirm it surfaces a friendly message on `intent_gone`/410 (a burned single-use intent) rather than a raw error; if it currently shows a generic error, map 410 → "that proposal expired — ask me to plan again".

- [ ] **Step 5: Verify atomic green** — `pnpm nx build shared && pnpm nx typecheck mobile`. Expected: shared builds; mobile shows ONLY the pre-existing `auth/client.ts:7` error — NO exhaustiveness error, NO error in PlanProposalCardBlock/PresentationBlock/ThreadView.

- [ ] **Step 6: Commit (one)**
```bash
git add libs/shared/src/dto/chat.ts apps/mobile/src/chat/blocks/PlanProposalCardBlock.tsx apps/mobile/src/chat/PresentationBlock.tsx apps/mobile/src/chat/ThreadView.tsx
git commit -m "feat(plan-card): plan_proposal_card shared block + live mobile card"
```

---

## Task 2: `addScheduledSpendBatchService` (atomic N-insert)

**Files:** `apps/api/src/schedules/service.ts`; Test `apps/api/tests/chat.tools.scheduled-spend-batch.test.ts`

READ `schedules/service.ts` first to confirm in-scope helpers: `withWorkspaceLock`, `workspaceOwnerTz`, `todayDateOnlyInTz`, `toDTO`, `ScheduledSpendError`, `rethrowValidation`, `validateAmount`, `parseOccurredAt`, `validateNote`, `Prisma`.

- [ ] **Step 1: Failing tests** (3): inserts all + returns; all-or-nothing (one bad category → zero rows); invalid amount rejected before any write. (Same as R1 — see git history; use category ids `groceries`/`dining`, a bogus id for the rollback case, `amount:-5` for the validation case.)

- [ ] **Step 2:** `pnpm nx test api -- scheduled-spend-batch` → FAIL.

- [ ] **Step 3: Implement** `[R2 — validators hoisted, no double-parse / no error-type divergence]`:
```ts
export type ScheduledSpendBatchItem = { categoryId: string; amount: number; scheduledDate: string; note?: string };

export async function addScheduledSpendBatchService(input: {
  workspaceId: string;
  items: ScheduledSpendBatchItem[];
}): Promise<{ schedules: ReturnType<typeof toDTO>[]; count: number }> {
  // Validate + normalize every item up front (fail before any write).
  const prepared = input.items.map((it) => ({
    categoryId: it.categoryId,
    amount: (rethrowValidation(() => validateAmount(it.amount)), it.amount),
    scheduledDate: rethrowValidation(() => parseOccurredAt(it.scheduledDate)),
    note: rethrowValidation(() => validateNote(it.note)),
  }));
  return await withWorkspaceLock(input.workspaceId, async (tx) => {
    const today = todayDateOnlyInTz(await workspaceOwnerTz(input.workspaceId));
    const schedules: ReturnType<typeof toDTO>[] = [];
    for (const it of prepared) {
      const cat = await tx.category.findFirst({
        where: { id: it.categoryId, workspaceId: input.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!cat) throw new ScheduledSpendError("category_not_found");
      const row = await tx.scheduledSpend.create({
        data: { workspaceId: input.workspaceId, categoryId: it.categoryId, amount: new Prisma.Decimal(it.amount), scheduledDate: it.scheduledDate, note: it.note },
        include: { matchedTx: { select: { removedAt: true } } },
      });
      schedules.push(toDTO(row, today));
    }
    return { schedules, count: schedules.length };
  });
}
```
(If `validateAmount` returns void, keep the comma-expression or split into a statement before the map — just ensure it throws on a bad amount before the lock.)

- [ ] **Step 4:** tests green; `pnpm nx typecheck api` no new error. **Step 5: Commit** `feat(api): addScheduledSpendBatchService — atomic N-insert`.

---

## Task 3 `[R2 — autonomous sizing]`: expose per-category `typicalAmount`

**Files:** `apps/api/src/budget-plans/service.ts`, `apps/api/src/analysis/forecast.ts`, `apps/api/src/chat/tools/compare-spending-vs-budget.ts`; Test append to `analysis.forecast.test.ts`.

- [ ] **Step 1: Failing test** in `analysis.forecast.test.ts`:
```ts
  it("exposes a per-category typical (median) transaction amount", async () => {
    await plan(500);
    for (const a of ["10.00","20.00","60.00"]) {
      const t = await prisma.transaction.create({ data: { workspaceId: wsId, accountId: acct, amount: a, merchantRaw: "M", occurredAt: new Date("2026-05-04T12:00:00Z"), source: "manual", pending: false, rawData: {} } });
      await prisma.transactionAllocation.create({ data: { transactionId: t.id, categoryId: dining, amount: a } });
    }
    const f = await projectMonthEnd(wsId, userId, 2026, 5);
    const c = f.categories.find((x) => x.categoryId === dining)!;
    expect(c.typicalAmount).toBeCloseTo(20, 2); // median of [10,20,60]
  });
```

- [ ] **Step 2:** FAIL (typicalAmount missing).

- [ ] **Step 3: Implement.** In `budget-plans/service.ts` add `recentTypicalAmountByCategory(workspaceId, categoryIds)` — 90-day positive allocations per category, return `Map<id, median>` (sort positives, pick middle; 0 if none). In `forecast.ts`: add `typicalAmount: number` to `CategoryForecast`; call the new fn in the `Promise.all`; set `typicalAmount: typicals.get(c.categoryId) ?? 0` per category; no-snap path doesn't list categories so unaffected. In `compare-spending-vs-budget.ts`: add `typicalAmount: string` to `Item`, set `typicalAmount: (fc?.typicalAmount ?? 0).toFixed(2)` (so the LLM sees it in the tool result — no card change).

- [ ] **Step 4:** test green; existing forecast/compare tests still green (run both files); typecheck api clean. **Step 5: Commit** `feat(api): expose per-category typical (median) amount for plan sizing`.

---

## Task 4: shared item zod + `addScheduledSpendBatch` executor + registrations

**Files:** create `apps/api/src/chat/tools/_scheduled-plan-item.ts`, `add-scheduled-spend-batch.ts`; modify `index.ts`, `intents/service.ts`, `audit/service.ts`; test append.

- [ ] **Step 1 `[R2 — one shared item zod, money-valid amount]`:** create `_scheduled-plan-item.ts`:
```ts
import { z } from "zod";
import { isValidAmount } from "@fina/shared";

/** Shared item shape for the batch executor AND the plan presenter so the two
 *  can never drift. amount uses the SAME money contract as validateAmount
 *  (AMOUNT_RE: <=2 decimals, in range) — a 3-decimal amount fails HERE, at
 *  card-creation, not later as a burned-intent consume failure. */
export const ScheduledPlanItem = z.object({
  category: z.string().min(1).max(80).describe("Category name (case-insensitive)"),
  amount: z.number().positive().refine(isValidAmount, "amount must have at most 2 decimals and be in range"),
  scheduled_date: z.string().describe("YYYY-MM-DD"),
  note: z.string().max(1000).optional(),
});
export type ScheduledPlanItemT = z.infer<typeof ScheduledPlanItem>;
```

- [ ] **Step 2: Failing tests** (executor): resolves names + creates all; unknown name → throws + zero rows. (As R1.)

- [ ] **Step 3: Executor** `add-scheduled-spend-batch.ts`:
```ts
import { z } from "zod";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { addScheduledSpendBatchService } from "../../schedules/service.js";
import { ScheduledPlanItem } from "./_scheduled-plan-item.js";

const Args = z.object({ items: z.array(ScheduledPlanItem).min(1).max(20) });

export const addScheduledSpendBatch: ToolDef<z.infer<typeof Args>, { schedules: unknown[]; count: number }> = {
  name: "addScheduledSpendBatch",
  description:
    "Create SEVERAL one-time scheduled expenses at once (max 20). DO NOT call directly — only via " +
    "presentScheduledSpendPlan so the user confirms once. Each item is a category name + amount + future YYYY-MM-DD.",
  args: Args,
  async run(ctx, args) {
    const cats = await prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }, { id: "asc" }], // [R2] deterministic resolution
    });
    const byLower = new Map<string, string>();
    for (const c of cats) { const k = c.name.toLowerCase(); if (!byLower.has(k)) byLower.set(k, c.id); } // first by orderBy
    const items = args.items.map((it) => {
      const id = byLower.get(it.category.toLowerCase());
      if (!id) throw new Error("category_not_found");
      return { categoryId: id, amount: it.amount, scheduledDate: it.scheduled_date, ...(it.note !== undefined ? { note: it.note } : {}) };
    });
    const out = await addScheduledSpendBatchService({ workspaceId: ctx.workspaceId, items });
    return { schedules: out.schedules, count: out.count };
  },
};
```

- [ ] **Step 4: Register** in `index.ts` (REGISTRY). **Step 5:** `intents/service.ts` — add `"addScheduledSpendBatch"` to `CONFIRMABLE_TOOLS` + confirmationFor case (`예정 지출 N개를 추가했어요.` / `Added N scheduled items.`). **Step 6:** `audit/service.ts` — add to `AUDIT_WRITE_TOOLS`, `TARGET_TYPE_MAP` (`scheduled_spend`), and an `extractTargetId` branch returning `null` (N rows, detail in payload/result).
- [ ] **Step 7:** tests green; typecheck clean. **Step 8: Commit** `feat(chat): addScheduledSpendBatch executor + intent/audit registration`.

---

## Task 5: `presentScheduledSpendPlan` presenter (pre-validate category + future date)

**Files:** create `present-scheduled-spend-plan.ts`; modify `index.ts`; test append.

- [ ] **Step 1: Failing tests:** (a) returns plan_proposal_card whose intent, consumed, creates all rows + `total` correct; (b) unknown category → throws, zero intents; `[R2]` (c) **past-dated** item → throws `date_in_past`, zero intents; `[R2]` (d) 3-decimal amount → throws (zod refine), zero intents.

- [ ] **Step 2:** FAIL.

- [ ] **Step 3: Presenter:**
```ts
import { z } from "zod";
import type { PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { createIntentService } from "../../intents/service.js";
import { workspaceOwnerTz, todayDateOnlyInTz } from "../../schedules/service.js"; // export these if not already
import { parseOccurredAt } from "@fina/shared";
import type { ToolDef } from "./types.js";
import { ScheduledPlanItem } from "./_scheduled-plan-item.js";

const Args = z.object({
  question: z.string().min(1).max(500),
  items: z.array(ScheduledPlanItem).min(1).max(20),
  accept_label: z.string().min(1).max(40).optional(),
  reject_label: z.string().min(1).max(40).optional(),
});
type PlanCard = Extract<PresentationBlock, { type: "plan_proposal_card" }>;

export const presentScheduledSpendPlan: ToolDef<z.infer<typeof Args>, { block: PlanCard }> = {
  name: "presentScheduledSpendPlan",
  description:
    "Propose a concrete multi-item spending plan as ONE Yes/No card; accept creates all items as scheduled spends. " +
    "Use after a forecast shows a category will run tight, or when the user asks for help planning. Dates MUST be in the " +
    "future; categories must already exist; size amounts from the user's words or the category's typicalAmount/remaining.",
  args: Args,
  async run(ctx, args) {
    // Resolve categories deterministically (same orderBy as the executor).
    const cats = await prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    const canonical = new Map<string, string>();
    for (const c of cats) { const k = c.name.toLowerCase(); if (!canonical.has(k)) canonical.set(k, c.name); }
    // [R2] reject future-date violations + unknown categories BEFORE issuing the single-use intent.
    const today = todayDateOnlyInTz(await workspaceOwnerTz(ctx.workspaceId)).getTime();
    for (const it of args.items) {
      if (!canonical.has(it.category.toLowerCase())) throw new Error("category_not_found");
      if (parseOccurredAt(it.scheduled_date).getTime() < today) throw new Error("date_in_past");
    }

    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { tool: "addScheduledSpendBatch", args: { items: args.items } },
    );
    const total = args.items.reduce((s, it) => s + it.amount, 0);
    return {
      block: {
        type: "plan_proposal_card",
        question: args.question,
        rows: args.items.map((it) => ({ category: canonical.get(it.category.toLowerCase())!, date: it.scheduled_date, amount: it.amount.toFixed(2), ...(it.note !== undefined ? { note: it.note } : {}) })),
        total: total.toFixed(2),
        accept_label: args.accept_label ?? "Schedule it",
        reject_label: args.reject_label ?? "Not now",
        accept_intent: out.intent.id,
      },
    };
  },
};
```
(If `workspaceOwnerTz`/`todayDateOnlyInTz` are not exported from schedules/service.ts, add `export`. `parseOccurredAt` is exported from `@fina/shared`.)

- [ ] **Step 4: Register** in `index.ts` (NOT in CONFIRMABLE_TOOLS). **Step 5:** tests green; typecheck clean. **Step 6: Commit** `feat(chat): presentScheduledSpendPlan presenter (future-date + category guards)`.

---

## Task 6: System-prompt copy

**Files:** `apps/api/src/chat/turn.ts`

- [ ] **Step 1:** READ the scheduled/confirm guidance area. Add:
```
- To help the user land within budget, PROPOSE a concrete plan with presentScheduledSpendPlan —
  specific FUTURE dates + amounts (e.g. "groceries twice: June 12 and 19, ~$60 each"). One card, one
  confirmation creates them all. NEVER call addScheduledSpendBatch directly — always go through
  presentScheduledSpendPlan. Don't loop addScheduledSpend. Only propose categories that exist.
  Size each amount from what the USER said, or from the category's typicalAmount and remaining budget
  (compareSpendingVsBudget exposes remaining, projected, runwayDay, typicalAmount per category); split
  the remaining sensibly across the number of trips. Dates must be after today.
```
- [ ] **Step 2:** typecheck api (no new error in turn.ts — check backticks). **Step 3: Commit** `feat(chat): prompt advisor to propose multi-item plans (guarded)`.

---

## Self-Review (R2)

**MUST-FIX folded in:** (1) ThreadView allowlist/dismissal/reject — Task 1 Step 4. (2) money-valid amount — `isValidAmount` refine in `_scheduled-plan-item.ts` (Task 4 Step 1), tested Task 5(d). (3) future-date guard in presenter — Task 5 Step 3, tested Task 5(c). (4) atomic shared+mobile commit — Task 1.

**SHOULD-CONSIDER folded in:** deterministic case-resolution (orderBy + first-wins, both tools), accept-button `colors.onPrimary`, hoisted validators (no double-parse), shared item zod (one source), `intent_gone`→friendly message (Task 1 Step 4). Inline snake_case zod over the spec's shared `ScheduledSpendBatchBody` is intentional (chat-tool args are snake_case, single consumer, no REST route) — factored into ONE api-local module to kill drift.

**Decisions:** direct-call forbidden via prompt (Task 6); accept/reject-only (no edit path — prompt sizes from user words/typicalAmount); autonomous sizing via exposed typicalAmount (Task 3).

**Type consistency:** `plan_proposal_card` identical across dto (T1), presenter return (T5), renderer (T1). `ScheduledPlanItem` is the ONE item zod used by both tools (T4/T5). `typicalAmount` flows forecast→item (T3). All registration touchpoints (CONFIRMABLE/AUDIT/TARGET_TYPE/extractTargetId/confirmationFor/REGISTRY) covered.

**Known v1 limits (accepted):** a genuine mid-run consume failure still burns the single-use intent (atomic, no partial rows; user re-asks). No per-field edit. Test DB (5433) must be up.
