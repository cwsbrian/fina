# Plan 1E-write Design: Chat Write Tools

**Date:** 2026-05-16
**Status:** Final design, ready for implementation planning
**Scope:** Two new write tools on existing data models. No schema migration. No new write paths for Budget/Goal (those are separate future plans).

---

## 1. Goal

Add two write tools to the Pro-tier chat assistant so the LLM can act on common product workflows, not just read:

- `createCategory` — create a new spending category in the current workspace, optionally under a parent category.
- `addTransactionNote` — set or clear the user-facing note on a transaction.

These are the 13th and 14th tools in the chat registry. Both operate on existing data models (`Category`, `Transaction`) and require no schema migration.

The chat surface has been read-only for the entire 1E plan family (1E-chat, 1E-next, 1E-threads, 1E-search). Adding these two writes lets the LLM finish common conversational requests like:

> "Make a new category called 'Coffee' under Food."
> "Add a note to that last $50 transaction: 'paid by John'."

Budget and Goal features are explicitly out of scope — they require new data models and are tracked as separate plans (1F-budget, 1G-goal).

---

## 2. Existing context

- The chat tool registry currently has 12 entries from prior plans (1E-chat-foundation, 1E-next, 1E-search). One existing write tool: `categorizeTransaction` (sets `categoryId` on a transaction + backfills sibling matches).
- `Category` has columns `id`, `workspaceId`, `name`, `parentId`, `icon`, `color`, `archivedAt`, `createdAt`. The migration `20260512170759_add_categorize` adds a partial unique index `categories_one_active_name_per_workspace_ci` on `(workspaceId, lower(name)) WHERE archivedAt IS NULL`.
- `Transaction.note` is `String?` (nullable). Already updatable; no schema change needed.
- The chat system prompt at `apps/api/src/chat/turn.ts` currently says `"Don't ask permission to look up data — just call the tool and show the result."` — written for read tools only.
- Chat is Pro + `editor` role per the matrix established in 1E-threads.

---

## 3. Decisions resolved during brainstorm

| Topic | Decision |
|---|---|
| Plan scope | Two write tools on existing models only. Budget/Goal deferred to separate plans. archive/rename of Category deferred — user is building UI controls separately. |
| Confirmation UX | System-prompt rule (option A): the LLM is instructed to confirm with the user before invoking write tools, unless the user's request is unambiguous. No tool-level two-phase confirm. No schema-side audit columns. |
| `createCategory` duplicate handling | Throw `category_exists` when an active category with the same case-insensitive name already exists. LLM tells the user and can switch to using the existing one. Archived siblings with the same name are allowed (matches the partial unique index). |
| `createCategory` shape | Args: `name` (required), `parent_name` (optional). No `color`/`icon` — UI concern, YAGNI. |
| `addTransactionNote` shape | Args: `tx_id` (required), `note` (required, `string \| null`). Replace semantics; `null` clears. Append is done by the LLM stitching old+new in its own arg. |
| `addTransactionNote` on soft-deleted txns | Allowed — notes are historical metadata; same-id detail tool already returns soft-deleted rows. |
| Tier / role gate | Inherited from chat route: Pro + `editor` role. Tools do not check themselves. |
| Audit columns | None. Existing `Category.createdAt` and `Transaction.updatedAt` suffice. |

---

## 4. File location

- Create: `apps/api/src/chat/tools/create-category.ts`
- Create: `apps/api/src/chat/tools/add-transaction-note.ts`
- Create: `apps/api/tests/chat.tools.create-category.test.ts`
- Create: `apps/api/tests/chat.tools.add-transaction-note.test.ts`
- Modify: `apps/api/src/chat/tools/index.ts` (add 13th and 14th entries)
- Modify: `apps/api/tests/chat.tools.registry.test.ts` (add `plan 1e-write` describe block)
- Modify: `apps/api/src/chat/turn.ts` — append one sentence to `SYSTEM_PROMPT` covering write confirmation behavior.

No other files. No schema migration.

---

## 5. `createCategory`

### 5.1 Identity

- **File:** `apps/api/src/chat/tools/create-category.ts`
- **Name:** `createCategory`
- **Description (LLM-facing):**
  > `"Create a new active category in the current workspace. Optional parent category by name. Throws category_exists if an active category with this name already exists."`

### 5.2 Args (Zod)

```typescript
const Args = z.object({
  name: z.string().min(1).max(80)
    .describe("Category name. Stored as-is; uniqueness check is case-insensitive against existing active categories in the workspace."),
  parent_name: z.string().min(1).max(80).optional()
    .describe("Optional parent category name (case-insensitive exact match against active categories). Omit for a top-level category."),
});
```

### 5.3 Behavior

1. If `parent_name` is provided: `prisma.category.findFirst({ where: { workspaceId, name: { equals, mode: "insensitive" }, archivedAt: null } })`. If not found → throw `parent_not_found`. If found → record `parentId`.
2. `prisma.category.create({ data: { workspaceId, name, parentId } })`.
3. Postgres unique violation (`P2002`) on `categories_one_active_name_per_workspace_ci` → catch and throw `category_exists`. The race is handled at the DB layer, not via a pre-check.
4. Return `{ category: { id, name, parentId, parentName } }` (parentName fetched from the `parent_name` arg or null).

### 5.4 Result type

```typescript
type Result = {
  category: {
    id: string;
    name: string;
    parentId: string | null;
    parentName: string | null;
  };
};
```

### 5.5 Errors

| Code | Trigger |
|---|---|
| `parent_not_found` | `parent_name` given but no active match in workspace |
| `category_exists` | Postgres unique violation on the partial active-name index |
| (Zod validation) | name/parent_name length out of range, types wrong |

---

## 6. `addTransactionNote`

### 6.1 Identity

- **File:** `apps/api/src/chat/tools/add-transaction-note.ts`
- **Name:** `addTransactionNote`
- **Description (LLM-facing):**
  > `"Set or clear the note on one transaction. Replaces the existing note entirely (pass null to clear)."`

### 6.2 Args (Zod)

```typescript
const Args = z.object({
  tx_id: z.string().min(1)
    .describe("Transaction id. Must belong to the current workspace."),
  note: z.union([z.string().min(1).max(1000), z.null()])
    .describe("New note text (1-1000 chars), or null to clear. REPLACES any existing note. To append, the LLM should first read the existing note via getTransactionDetails and submit the combined text."),
});
```

### 6.3 Behavior

1. `prisma.transaction.findFirst({ where: { id: tx_id, workspaceId: ctx.workspaceId } })`. Soft-deleted (`removedAt != null`) rows ARE returned — notes are historical metadata.
2. If null → throw `transaction_not_found`.
3. `prisma.transaction.update({ where: { id }, data: { note } })`.
4. Return `{ tx: { id, note, updatedAt } }`.

### 6.4 Result type

```typescript
type Result = {
  tx: {
    id: string;
    note: string | null;
    updatedAt: string; // ISO
  };
};
```

### 6.5 Errors

| Code | Trigger |
|---|---|
| `transaction_not_found` | Missing id OR cross-workspace id (same code intentionally — no existence leak) |
| (Zod validation) | note empty string (must be either ≥1 char or `null`), > 1000 chars |

---

## 7. System prompt update

In `apps/api/src/chat/turn.ts`, the existing `SYSTEM_PROMPT` ends with:

> `"Don't ask permission to look up data — just call the tool and show the result."`

Append one paragraph:

> `"For write tools (createCategory, addTransactionNote), briefly confirm with the user before invoking unless the request is unambiguous. Example unambiguous: '카테고리 만들어줘 — Coffee 라는 이름으로'. Example needs confirmation: 'Coffee 카테고리 따로 두는 게 좋을까?'"`

That single addition is the entire confirmation UX surface. The LLM uses its judgment; no tool-side gating.

---

## 8. Registry + tests

### 8.1 Registry update

`apps/api/src/chat/tools/index.ts` adds two imports + two registry entries:

```typescript
import { createCategory } from "./create-category.js";
import { addTransactionNote } from "./add-transaction-note.js";

export const REGISTRY: ToolDef[] = [
  // ... 12 existing ...,
  createCategory as ToolDef,
  addTransactionNote as ToolDef,
];
```

### 8.2 Registry test addition

Append a new `describe("REGISTRY (plan 1e-write)", () => { ... })` block to `apps/api/tests/chat.tools.registry.test.ts` with 4 cases (matching the per-plan pattern from 1e-next and 1e-search):

- contains both new tool names
- exact description strings match the spec
- every top-level Zod arg has a non-empty `.describe()`
- Gemini declarations emit `parametersJsonSchema`

### 8.3 Per-tool tests

`apps/api/tests/chat.tools.create-category.test.ts` (~9 cases):
1. Creates a top-level category, returns row with parent null.
2. Creates a child under existing active parent (case-insensitive lookup).
3. `parent_name` not found → throws `parent_not_found`.
4. Duplicate active name → throws `category_exists`.
5. Duplicate name where the existing row is `archivedAt != null` → creates successfully (partial unique allows it).
6. Cross-workspace `parent_name` not visible → throws `parent_not_found`.
7. Workspace isolation: row created in correct workspaceId, not visible from another.
8. Zod: name length > 80 → fails before run.
9. Zod: parent_name length > 80 → fails before run.

`apps/api/tests/chat.tools.add-transaction-note.test.ts` (~7 cases):
1. Sets a note on an active transaction.
2. Replaces an existing note (not appended).
3. `note: null` clears the note.
4. Soft-deleted transaction can still have its note edited.
5. Unknown `tx_id` → throws `transaction_not_found`.
6. Cross-workspace `tx_id` → throws `transaction_not_found` (same code).
7. Zod: note empty string → fails (must be 1-1000 chars or null).
8. Zod: note > 1000 chars → fails.

---

## 9. Acceptance criteria

This plan is complete when:

- `createCategory` and `addTransactionNote` registered as the 13th and 14th entries in `REGISTRY`.
- Exact description strings from §5.1 and §6.1.
- All args have `.describe()` text.
- `createCategory` correctly looks up parent case-insensitively in active categories.
- `createCategory` throws `category_exists` on the partial unique violation; allows archived-sibling reuse of the name.
- `addTransactionNote` replaces (not appends); `null` clears; soft-deleted rows allowed.
- Both tools enforce `workspaceId: ctx.workspaceId` in all queries.
- Cross-workspace `tx_id` and `parent_name` return the same `_not_found` codes as in-workspace misses (no existence leak).
- Tier and role gating come entirely from the chat route — these tools do NOT call `effectiveTier` or `requireWorkspaceContext`.
- System prompt has the new confirmation paragraph.
- All per-tool tests pass; registry test bumped from 12 to 14 expected tools.
- Existing 12 tool tests untouched and still passing.

---

## 10. Excluded scope

The following are explicitly NOT in this plan:

- `archiveCategory`, `renameCategory`, `setCategoryParent` — user has UI controls in flight.
- `archiveTransaction` / hard-delete of a transaction — Plaid is the source of truth; chat shouldn't introduce data divergence.
- Budget / Goal features — separate future plans (no data model yet).
- Color/icon args on `createCategory` — UI concern.
- Tool-level confirmation tokens (two-phase commit) — rejected during brainstorm.
- Bulk operations (e.g., note many transactions at once) — out of scope until a real demand surfaces.
- Audit log columns — `Category.createdAt` + `Transaction.updatedAt` are enough.

---

## 11. Follow-up candidates

- **Plan 1F-budget**: `Budget` data model + migration + read tools (`getBudget`, `compareSpendingVsBudget`) + write tool (`setMonthlyBudget`). Foundational, multi-task.
- **Plan 1G-goal**: `Goal` data model + tools.
- **Plan 1E-write-extras** (if needed later): `archiveCategory`, `renameCategory`, etc. — only if users actually request via chat after UI lands.
- **Plan 1E-UI**: web/mobile rendering of the 14 tools (user is already working on this separately).
