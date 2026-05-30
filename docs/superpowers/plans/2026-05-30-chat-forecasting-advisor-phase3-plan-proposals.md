# Chat Forecasting Advisor — Phase 3 (Plan Proposals) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let the advisor propose a multi-item spending plan in chat ("schedule groceries twice — on the 3rd and the 10th — for ~$60 each?") and create all the ScheduledSpends with a single confirmation tap.

**Architecture:** A new `addScheduledSpendBatch` executor inserts N scheduled spends atomically inside one workspace lock. A new `presentScheduledSpendPlan` presenter validates the items, creates ONE ActionIntent targeting the batch tool, and returns a `plan_proposal_card` listing each line. This reuses the existing intent → consume → audit machinery (no route changes) and the existing mobile confirm-card accept/reject consume flow.

**Tech Stack:** Fastify + Prisma, Zod, Vitest (real DB), `@fina/shared`, Gemini chat tools, React Native (mobile renderer).

**Spec:** `docs/superpowers/specs/2026-05-29-chat-forecasting-advisor-design.md` (§F, decision #4).

**Correct commands:** api test `pnpm nx test api -- <pattern>`; mobile typecheck `pnpm nx typecheck mobile` (pre-existing unrelated errors exist — bar is no NEW error in changed files); shared build `pnpm nx build shared`. (`pnpm --filter ... test` does NOT work — no test script.)

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `libs/shared/src/dto/chat.ts` | Modify | Add `plan_proposal_card` PresentationBlock variant |
| `apps/api/src/schedules/service.ts` | Modify | `addScheduledSpendBatchService` — validate all, insert N in one lock (atomic) |
| `apps/api/src/chat/tools/add-scheduled-spend-batch.ts` | Create | `addScheduledSpendBatch` executor tool (resolve names → ids, call batch service) |
| `apps/api/src/chat/tools/present-scheduled-spend-plan.ts` | Create | `presentScheduledSpendPlan` presenter (pre-validate, create intent, return card) |
| `apps/api/src/chat/tools/index.ts` | Modify | Register both new tools in REGISTRY |
| `apps/api/src/intents/service.ts` | Modify | Add to CONFIRMABLE_TOOLS + a `confirmationFor` case |
| `apps/api/src/audit/service.ts` | Modify | AUDIT_WRITE_TOOLS + TARGET_TYPE_MAP + extractTargetId branch |
| `apps/api/src/chat/turn.ts` | Modify | System-prompt copy: propose plans via presentScheduledSpendPlan |
| `apps/mobile/src/chat/blocks/PlanProposalCardBlock.tsx` | Create | Renders the plan card + Yes/No wired to onAccept/onReject |
| `apps/mobile/src/chat/PresentationBlock.tsx` | Modify | Dispatch `plan_proposal_card` → PlanProposalCardBlock |
| `apps/api/tests/chat.tools.scheduled-spend-batch.test.ts` | Create | Batch executor + presenter + consume + audit + rollback tests |

---

## Task 1: Shared `plan_proposal_card` block

**Files:** Modify `libs/shared/src/dto/chat.ts`

- [ ] **Step 1: Add the variant** to the `PresentationBlock` union (after the `confirm_card` variant, mirroring its shape):

```ts
  | {
      /** A proposed multi-item plan (e.g. "schedule groceries twice").
       *  Backed by ONE ActionIntent targeting addScheduledSpendBatch; the
       *  whole plan is created on accept. Mirrors confirm_card's accept/reject
       *  intent flow — the renderer reuses the same consume path. */
      type: "plan_proposal_card";
      question: string;
      rows: { category: string; date: string; amount: string; note?: string }[];
      /** Stringified sum of all row amounts, no currency symbol. */
      total: string;
      accept_label: string;
      reject_label: string;
      accept_intent: string;
      reject_intent?: string;
    }
```

- [ ] **Step 2:** `pnpm nx build shared && pnpm nx typecheck mobile`
Expected: shared builds; mobile fails ONLY at the pre-existing auth error AND a NEW exhaustiveness error in `PresentationBlock.tsx` (the `never` cast) — that's expected until Task 9 adds the renderer case. Note it; do not "fix" by reverting.

- [ ] **Step 3: Commit**
```bash
git add libs/shared/src/dto/chat.ts
git commit -m "feat(shared): plan_proposal_card presentation block"
```

---

## Task 2: `addScheduledSpendBatchService` (atomic N-insert)

**Files:** Modify `apps/api/src/schedules/service.ts`; Test `apps/api/tests/chat.tools.scheduled-spend-batch.test.ts`

First READ `apps/api/src/schedules/service.ts` to confirm the imports in scope: `withWorkspaceLock`, `workspaceOwnerTz`, `todayDateOnlyInTz`, `toDTO`, `ScheduledSpendError`, `rethrowValidation`, `validateAmount`, `parseOccurredAt`, `validateNote`, `Prisma`, and the `ScheduledSpendDTO` / `AddScheduledSpendResult` types. Reuse them; do not re-import duplicates.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/tests/chat.tools.scheduled-spend-batch.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { addScheduledSpendBatchService } from "../src/schedules/service.js";

describe("addScheduledSpendBatchService", () => {
  let wsId: string;
  let dining: string;
  let groceries: string;

  beforeEach(async () => {
    const stamp = `ssb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "SSB", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    dining = (await prisma.category.create({ data: { workspaceId: wsId, name: "Dining" } })).id;
    groceries = (await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } })).id;
  });
  afterEach(async () => { await prisma.workspace.deleteMany({ where: { id: wsId } }); });

  it("inserts every item and returns them", async () => {
    const out = await addScheduledSpendBatchService({
      workspaceId: wsId,
      items: [
        { categoryId: groceries, amount: 60, scheduledDate: "2026-06-03" },
        { categoryId: groceries, amount: 60, scheduledDate: "2026-06-10", note: "stock up" },
      ],
    });
    expect(out.count).toBe(2);
    const rows = await prisma.scheduledSpend.findMany({ where: { workspaceId: wsId } });
    expect(rows).toHaveLength(2);
  });

  it("is all-or-nothing: one bad category rolls back the whole batch", async () => {
    await expect(
      addScheduledSpendBatchService({
        workspaceId: wsId,
        items: [
          { categoryId: groceries, amount: 60, scheduledDate: "2026-06-03" },
          { categoryId: "does-not-exist", amount: 60, scheduledDate: "2026-06-10" },
        ],
      }),
    ).rejects.toThrow();
    const rows = await prisma.scheduledSpend.findMany({ where: { workspaceId: wsId } });
    expect(rows).toHaveLength(0); // first insert rolled back
  });

  it("rejects an invalid amount before any write", async () => {
    await expect(
      addScheduledSpendBatchService({
        workspaceId: wsId,
        items: [{ categoryId: dining, amount: -5, scheduledDate: "2026-06-03" }],
      }),
    ).rejects.toThrow();
    expect(await prisma.scheduledSpend.count({ where: { workspaceId: wsId } })).toBe(0);
  });
});
```

- [ ] **Step 2:** Run `pnpm nx test api -- scheduled-spend-batch` → FAIL (service not exported).

- [ ] **Step 3: Implement** in `schedules/service.ts`:

```ts
export type ScheduledSpendBatchItem = {
  categoryId: string;
  amount: number;
  scheduledDate: string; // YYYY-MM-DD
  note?: string;
};

/** Insert N scheduled spends atomically in one workspace lock. Validates
 *  every item up front (amount/date/note) so a bad item fails BEFORE any
 *  write; category existence is re-checked inside the lock per row. If any
 *  row fails, the surrounding transaction rolls the whole batch back. */
export async function addScheduledSpendBatchService(input: {
  workspaceId: string;
  items: ScheduledSpendBatchItem[];
}): Promise<{ schedules: ReturnType<typeof toDTO>[]; count: number }> {
  for (const it of input.items) {
    rethrowValidation(() => validateAmount(it.amount));
    rethrowValidation(() => parseOccurredAt(it.scheduledDate));
    rethrowValidation(() => validateNote(it.note));
  }
  return await withWorkspaceLock(input.workspaceId, async (tx) => {
    const ownerTz = await workspaceOwnerTz(input.workspaceId);
    const today = todayDateOnlyInTz(ownerTz);
    const schedules: ReturnType<typeof toDTO>[] = [];
    for (const it of input.items) {
      const cat = await tx.category.findFirst({
        where: { id: it.categoryId, workspaceId: input.workspaceId, archivedAt: null },
        select: { id: true },
      });
      if (!cat) throw new ScheduledSpendError("category_not_found");
      const row = await tx.scheduledSpend.create({
        data: {
          workspaceId: input.workspaceId,
          categoryId: it.categoryId,
          amount: new Prisma.Decimal(it.amount),
          scheduledDate: parseOccurredAt(it.scheduledDate),
          note: validateNote(it.note),
        },
        include: { matchedTx: { select: { removedAt: true } } },
      });
      schedules.push(toDTO(row, today));
    }
    return { schedules, count: schedules.length };
  });
}
```
(If `toDTO`'s return type isn't easily referenced, declare an explicit `ScheduledSpendDTO[]` using the type `addScheduledSpendService` returns in its `schedule` field.)

- [ ] **Step 4:** `pnpm nx test api -- scheduled-spend-batch` → 3 passing. `pnpm nx typecheck api` → no NEW error in schedules/service.ts.

- [ ] **Step 5: Commit**
```bash
git add apps/api/src/schedules/service.ts apps/api/tests/chat.tools.scheduled-spend-batch.test.ts
git commit -m "feat(api): addScheduledSpendBatchService — atomic N-insert"
```

---

## Task 3: `addScheduledSpendBatch` executor tool + registrations

**Files:** Create `apps/api/src/chat/tools/add-scheduled-spend-batch.ts`; Modify `index.ts`, `intents/service.ts`, `audit/service.ts`; Test (append).

- [ ] **Step 1: Append test** (to the batch test file):

```ts
import { addScheduledSpendBatch } from "../src/chat/tools/add-scheduled-spend-batch.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("addScheduledSpendBatch tool", () => {
  let ctx: ToolContext; let wsId: string; let groceries: string;
  beforeEach(async () => {
    const stamp = `ssbt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "T", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    groceries = (await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });
  afterEach(async () => { await prisma.workspace.deleteMany({ where: { id: wsId } }); });

  it("resolves category names and creates all schedules", async () => {
    const r = await addScheduledSpendBatch.run(ctx, {
      items: [
        { category: "groceries", amount: 60, scheduled_date: "2026-06-03" },
        { category: "Groceries", amount: 55, scheduled_date: "2026-06-10" },
      ],
    });
    expect(r.count).toBe(2);
    expect(await prisma.scheduledSpend.count({ where: { workspaceId: wsId } })).toBe(2);
  });

  it("throws category_not_found and writes nothing when a name is unknown", async () => {
    await expect(addScheduledSpendBatch.run(ctx, {
      items: [
        { category: "groceries", amount: 60, scheduled_date: "2026-06-03" },
        { category: "Nope", amount: 60, scheduled_date: "2026-06-10" },
      ],
    })).rejects.toThrow();
    expect(await prisma.scheduledSpend.count({ where: { workspaceId: wsId } })).toBe(0);
  });
});
```

- [ ] **Step 2:** Run → FAIL (tool missing).

- [ ] **Step 3: Create** `apps/api/src/chat/tools/add-scheduled-spend-batch.ts`:

```ts
import { z } from "zod";
import { MAX_AMOUNT } from "@fina/shared";
import { prisma } from "../../db.js";
import type { ToolDef } from "./types.js";
import { addScheduledSpendBatchService } from "../../schedules/service.js";

const Item = z.object({
  category: z.string().min(1).max(80).describe("Category name (case-insensitive)"),
  amount: z.number().positive().max(MAX_AMOUNT).describe("Planned amount"),
  scheduled_date: z.string().describe("YYYY-MM-DD"),
  note: z.string().max(1000).optional(),
});
const Args = z.object({ items: z.array(Item).min(1).max(20) });

type Result = { schedules: unknown[]; count: number };

export const addScheduledSpendBatch: ToolDef<z.infer<typeof Args>, Result> = {
  name: "addScheduledSpendBatch",
  description:
    "Create SEVERAL one-time future scheduled expenses at once (e.g. two grocery trips). " +
    "Each item is a category name + amount + YYYY-MM-DD date. Max 20 items. Use this (via " +
    "presentScheduledSpendPlan) when proposing a concrete multi-step plan so the user confirms once.",
  args: Args,
  async run(ctx, args) {
    // Resolve all category names → ids in one query, case-insensitively.
    const cats = await prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      select: { id: true, name: true },
    });
    const byLower = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
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

- [ ] **Step 4: Register** in `apps/api/src/chat/tools/index.ts` — import `addScheduledSpendBatch` and add it to the `REGISTRY` array (follow the existing import+array pattern).

- [ ] **Step 5: Mark confirmable** in `apps/api/src/intents/service.ts`: add `"addScheduledSpendBatch",` to the `CONFIRMABLE_TOOLS` array, and add a `confirmationFor` case:
```ts
    case "addScheduledSpendBatch": {
      const n = (result as { count?: number }).count ?? 0;
      return ko ? `예정 지출 ${n}개를 추가했어요.` : `Added ${n} scheduled item${n === 1 ? "" : "s"}.`;
    }
```

- [ ] **Step 6: Audit** in `apps/api/src/audit/service.ts`: add `"addScheduledSpendBatch"` to `AUDIT_WRITE_TOOLS`; add `addScheduledSpendBatch: "scheduled_spend"` to `TARGET_TYPE_MAP`; add an `extractTargetId` branch:
```ts
  if (action === "addScheduledSpendBatch") {
    // A batch maps to N rows — no single targetId. The audit row's payload
    // (the items[]) and result (the created schedules) carry the detail.
    return null;
  }
```

- [ ] **Step 7:** Run `pnpm nx test api -- scheduled-spend-batch` → all passing. `pnpm nx typecheck api` → no new error in changed files.

- [ ] **Step 8: Commit**
```bash
git add apps/api/src/chat/tools/add-scheduled-spend-batch.ts apps/api/src/chat/tools/index.ts apps/api/src/intents/service.ts apps/api/src/audit/service.ts apps/api/tests/chat.tools.scheduled-spend-batch.test.ts
git commit -m "feat(chat): addScheduledSpendBatch executor + intent/audit registration"
```

---

## Task 4: `presentScheduledSpendPlan` presenter + consume test

**Files:** Create `apps/api/src/chat/tools/present-scheduled-spend-plan.ts`; Modify `index.ts`; Test (append).

- [ ] **Step 1: Append test** (presenter creates a valid intent + card; consume runs the batch):

```ts
import { presentScheduledSpendPlan } from "../src/chat/tools/present-scheduled-spend-plan.js";
import { consumeIntentService } from "../src/intents/service.js";

describe("presentScheduledSpendPlan + consume", () => {
  let ctx: ToolContext; let wsId: string; let userId: string; let groceries: string;
  beforeEach(async () => {
    const stamp = `pssp-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "P", tz: "America/Toronto" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: stamp, currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    groceries = (await prisma.category.create({ data: { workspaceId: wsId, name: "Groceries" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId, role: "owner" };
  });
  afterEach(async () => { await prisma.workspace.deleteMany({ where: { id: wsId } }); });

  it("returns a plan_proposal_card whose intent, when consumed, creates all rows", async () => {
    const r = await presentScheduledSpendPlan.run(ctx, {
      question: "장 2번 잡을까요?",
      items: [
        { category: "Groceries", amount: 60, scheduled_date: "2026-06-03" },
        { category: "Groceries", amount: 55, scheduled_date: "2026-06-10" },
      ],
    });
    expect(r.block.type).toBe("plan_proposal_card");
    expect(r.block.rows).toHaveLength(2);
    expect(r.block.total).toBe("115.00");
    const intentId = r.block.accept_intent;

    await consumeIntentService({ env: {} as never, workspaceId: wsId, userId, role: "owner" }, intentId);
    expect(await prisma.scheduledSpend.count({ where: { workspaceId: wsId } })).toBe(2);
  });

  it("rejects an unknown category before issuing a card", async () => {
    await expect(presentScheduledSpendPlan.run(ctx, {
      question: "?",
      items: [{ category: "Nope", amount: 10, scheduled_date: "2026-06-03" }],
    })).rejects.toThrow();
    expect(await prisma.actionIntent.count({ where: { workspaceId: wsId } })).toBe(0);
  });
});
```

- [ ] **Step 2:** Run → FAIL.

- [ ] **Step 3: Create** `apps/api/src/chat/tools/present-scheduled-spend-plan.ts`:

```ts
import { z } from "zod";
import { MAX_AMOUNT, type PresentationBlock } from "@fina/shared";
import { prisma } from "../../db.js";
import { createIntentService } from "../../intents/service.js";
import type { ToolDef } from "./types.js";

const Item = z.object({
  category: z.string().min(1).max(80),
  amount: z.number().positive().max(MAX_AMOUNT),
  scheduled_date: z.string().describe("YYYY-MM-DD"),
  note: z.string().max(1000).optional(),
});
const Args = z.object({
  question: z.string().min(1).max(500),
  items: z.array(Item).min(1).max(20),
  accept_label: z.string().min(1).max(40).optional(),
  reject_label: z.string().min(1).max(40).optional(),
});

type PlanCard = Extract<PresentationBlock, { type: "plan_proposal_card" }>;

export const presentScheduledSpendPlan: ToolDef<z.infer<typeof Args>, { block: PlanCard }> = {
  name: "presentScheduledSpendPlan",
  description:
    "Propose a concrete multi-item spending plan (e.g. 'groceries twice — June 3 and 10, ~$60 each') as a " +
    "single Yes/No card. On accept, all items are created as scheduled spends at once. Use after a forecast " +
    "shows a category will run tight, or when the user asks for help planning. Category names must already exist.",
  args: Args,
  async run(ctx, args) {
    // Pre-validate category existence so we never show a card that will fail
    // on consume (the intent is single-use). Resolve names case-insensitively.
    const cats = await prisma.category.findMany({
      where: { workspaceId: ctx.workspaceId, archivedAt: null },
      select: { id: true, name: true },
    });
    const byLower = new Map(cats.map((c) => [c.name.toLowerCase(), c.name]));
    for (const it of args.items) {
      if (!byLower.has(it.category.toLowerCase())) throw new Error("category_not_found");
    }

    const out = await createIntentService(
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
      { tool: "addScheduledSpendBatch", args: { items: args.items } },
    );

    const total = args.items.reduce((sum, it) => sum + it.amount, 0);
    return {
      block: {
        type: "plan_proposal_card",
        question: args.question,
        rows: args.items.map((it) => ({
          category: byLower.get(it.category.toLowerCase())!, // canonical-cased name
          date: it.scheduled_date,
          amount: it.amount.toFixed(2),
          ...(it.note !== undefined ? { note: it.note } : {}),
        })),
        total: total.toFixed(2),
        accept_label: args.accept_label ?? "Schedule it",
        reject_label: args.reject_label ?? "Not now",
        accept_intent: out.intent.id,
      },
    };
  },
};
```

- [ ] **Step 4: Register** `presentScheduledSpendPlan` in `index.ts` REGISTRY (presenter is NOT added to CONFIRMABLE_TOOLS — it's the SOURCE of intents, like presentRecurringForm).

- [ ] **Step 5:** Run `pnpm nx test api -- scheduled-spend-batch` → all passing. Typecheck api → clean.

- [ ] **Step 6: Commit**
```bash
git add apps/api/src/chat/tools/present-scheduled-spend-plan.ts apps/api/src/chat/tools/index.ts apps/api/tests/chat.tools.scheduled-spend-batch.test.ts
git commit -m "feat(chat): presentScheduledSpendPlan presenter + plan_proposal_card"
```

---

## Task 5: System-prompt copy — proposing plans

**Files:** Modify `apps/api/src/chat/turn.ts`

- [ ] **Step 1:** READ the system prompt area that lists scheduled-spend / confirm-card guidance (search `presentConfirmCard`, `addScheduledSpend`, `scheduled`). Add a rule near there:

```
- When the user wants help spending the rest of a category's budget, or a forecast shows a
  category will run tight and the user agrees to plan, PROPOSE a concrete plan with
  presentScheduledSpendPlan — specific dates + amounts (e.g. "groceries twice: June 3 and 10,
  ~$60 each"). One card, one confirmation creates them all. Don't call addScheduledSpend in a
  loop. Only propose categories that already exist. Keep proposals realistic vs the remaining budget.
```
Keep the existing single-add guidance for one-off scheduled spends.

- [ ] **Step 2:** `pnpm nx typecheck api` → no new error in turn.ts (you edited a template string; check backticks).

- [ ] **Step 3: Commit**
```bash
git add apps/api/src/chat/turn.ts
git commit -m "feat(chat): prompt the advisor to propose multi-item plans"
```

---

## Task 6: Mobile `plan_proposal_card` renderer

**Files:** Create `apps/mobile/src/chat/blocks/PlanProposalCardBlock.tsx`; Modify `apps/mobile/src/chat/PresentationBlock.tsx`

First READ `apps/mobile/src/chat/PresentationBlock.tsx` (the `confirm_card` case, lines ~51-79, + the `styles` it uses) to reuse the card/button styles.

- [ ] **Step 1: Create** `PlanProposalCardBlock.tsx` — render the question, a list of `{date · category · amount}` rows + total, and Yes/No buttons wired to callbacks. Mirror confirm_card's button styling (import shared styles or reproduce them locally with the same token usage). Signature:

```tsx
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";

type PlanCard = Extract<PresentationBlock, { type: "plan_proposal_card" }>;

export function PlanProposalCardBlock({
  block,
  onAccept,
  onReject,
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
  acceptText: { ...type$.bodyMd, color: colors.canvas, fontWeight: "600" },
});
```
(If a token like `colors.primary`/`type$.bodySm` doesn't exist, use the nearest one the confirm_card case already uses — match what's in `design/tokens`.)

- [ ] **Step 2: Dispatch** in `PresentationBlock.tsx` — add the import and a case BEFORE the final never-cast:
```tsx
import { PlanProposalCardBlock } from "./blocks/PlanProposalCardBlock";
// ...
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

- [ ] **Step 3:** `pnpm nx typecheck mobile` → the Task-1 exhaustiveness error is now GONE; only the pre-existing auth error remains. Confirm no error references PlanProposalCardBlock / PresentationBlock.

- [ ] **Step 4: Commit**
```bash
git add apps/mobile/src/chat/blocks/PlanProposalCardBlock.tsx apps/mobile/src/chat/PresentationBlock.tsx
git commit -m "feat(mobile): render plan_proposal_card with one-tap confirm"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** batch tool atomic (Task 2), max 20 + MAX_AMOUNT per item (Task 3 zod), full validation before intent stamped (presenter pre-validates categories Task 4; service validates amounts before write Task 2), audit summary row with items[] payload (Task 3), routed through ActionIntent/confirm flow with editor+Pro consume gate inherited (presenter creates intent; consume route unchanged), one-confirmation UX (Task 6). Brief-warns/chat-proposes split lives in prompt copy (Task 5); the brief-side surfacing is Phase 4.

**Placeholder scan:** none — every step has real code/tests.

**Type consistency:** `plan_proposal_card` shape identical across dto (Task 1), presenter return (Task 4), and mobile renderer (Task 6). `addScheduledSpendBatch` name consistent across tool/index/CONFIRMABLE_TOOLS/AUDIT_WRITE_TOOLS/TARGET_TYPE_MAP/extractTargetId/confirmationFor. `addScheduledSpendBatchService` item shape (`{categoryId, amount, scheduledDate, note?}`) matches between Task 2 and the Task 3 tool's mapping.

**Consume-burn risk:** the intent is stamped consumed before `tool.run` (intents/service.ts:227). Mitigated: presenter pre-validates categories so the card only shows for a valid plan; the executor validates all amounts/dates BEFORE the transaction and inserts atomically, so a consume either fully succeeds or fully rolls back (no partial rows). A genuine mid-run failure still burns the intent — acceptable v1; the user re-asks. Not adding a re-issue path in v1.

**Viewer gate:** add a `consumeIntentService` viewer-role test only if the consume route's role enforcement isn't already covered elsewhere — the route (`routes/intents.ts`) enforces editor+Pro before calling the service, so role gating is a route concern, not re-tested here.

**Test runner:** real DB — ensure Postgres (5433) up + migrated before running.
```
