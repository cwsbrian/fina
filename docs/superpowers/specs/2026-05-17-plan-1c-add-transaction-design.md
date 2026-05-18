# Plan 1C-add-transaction — manual transaction HTTP endpoint

**Date:** 2026-05-17
**Status:** Spec
**Sub-plan of:** 1C (Agent Writes), per master design §5 (`addTransaction({...})`) and §8 ("Manual transaction도 'Cash' 같은 자동생성 manual account에 attach")

---

## 1. Goal

Provide `POST /workspaces/:id/transactions/manual` — the only path to add a
transaction that didn't come through Plaid sync. Required for Free-tier users
(Plaid not available; manual + CSV only) and useful for everyone (cash
purchases, foreign banks not in Plaid Canada coverage, splits).

Out of scope: chat tool, editTransaction, deleteTransaction, CSV import.

---

## 2. Decisions

| Topic | Decision |
|---|---|
| Surface | HTTP route only — `POST /workspaces/:id/transactions/manual` |
| Chat tool | Out of scope. Manual entry is UI-driven; LLM dispatch is overkill. |
| Tier gate | None — all tiers can add manual transactions (Free-tier core path) |
| Role gate | editor+ via `requireWorkspaceContext` |
| Confirmation | None — additive, low-risk, idempotency keyed by the auto-cuid |
| Account attachment | Auto-find or auto-create a "Cash" manual account (`plaidItemId IS NULL`); user may override via `accountId` |
| Currency | New `Workspace.currency` field (default `"CAD"`). `addTransaction` does NOT accept a `currency` arg — server copies from workspace. |
| Per-row `currency` columns | Unchanged. `Transaction.currency` is set from `Workspace.currency` on insert. Per-row cleanup is a follow-up (1C-currency-unify). |
| Source | `source = "manual"`, `plaidTransactionId = null`, `plaidItemId = null`, `rawData = {}` |
| Merchant normalization | Server-side via existing `normalizeMerchant` helper |
| Audit | Inherits the existing audit hook? **No** — audit hooks fire only in `processChatTurn` and `consumeIntentService`. HTTP routes are not audited in v1 (matches the documented limitation in 1C-audit §11). A future `1C-audit-http` plan can add a hook here. |

---

## 3. Data model changes

### 3.1 `Workspace.currency`

```prisma
model Workspace {
  // ... existing fields
  currency String @default("CAD")
}
```

Migration:
```sql
ALTER TABLE "workspaces" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'CAD';
```

All existing workspaces backfill to `'CAD'`. No data loss.

### 3.2 No `Transaction` / `BankAccount` schema changes

Existing per-row `currency` columns remain. They now receive `Workspace.currency`
on manual inserts (instead of the static `"CAD"` default).

---

## 4. Endpoint contract

### Request

```
POST /workspaces/:id/transactions/manual
Headers:
  Cookie: <session>
  X-Workspace-Id: <id>          (must match path :id)
  Content-Type: application/json

Body:
{
  "merchantRaw": "Starbucks Yonge & Eglinton",   // required
  "amount": 6.75,                                 // required, > 0
  "occurredAt": "2026-05-17",                    // optional, YYYY-MM-DD, defaults to today (user's tz)
  "categoryId": "cmp...",                        // optional
  "note": "morning coffee",                      // optional, max 1000
  "accountId": "cmp..."                          // optional (manual account override)
}
```

### Success (201)

```json
{
  "transaction": {
    "id": "cmp...",
    "amount": "6.75",
    "currency": "CAD",
    "merchantRaw": "Starbucks Yonge & Eglinton",
    "merchantNormalized": "starbucks",
    "categoryId": "cmp...",
    "occurredAt": "2026-05-17T12:00:00.000Z",
    "note": "morning coffee",
    "source": "manual",
    "accountId": "cmp...",
    "createdAt": "..."
  }
}
```

### Error codes

| HTTP | Code | Cause |
|---|---|---|
| 400 | `invalid_body` | Zod parse failure (missing required, wrong type) |
| 400 | `invalid_amount` | amount ≤ 0, NaN, Infinity, or > 999,999,999.99 |
| 400 | `invalid_date` | `occurredAt` provided but not parseable as YYYY-MM-DD |
| 400 | `invalid_note` | note > 1000 chars |
| 400 | `invalid_merchant` | merchantRaw empty or > 200 chars after trim |
| 400 | `workspace_mismatch` | path `:id` ≠ `X-Workspace-Id` |
| 401 | (auth) | Better Auth handles |
| 403 | `insufficient_role` | viewer role |
| 404 | `category_not_found` | `categoryId` not in workspace, or archived |
| 404 | `account_not_found` | `accountId` not in workspace, or `plaidItemId IS NOT NULL` |

---

## 5. Service module

`apps/api/src/transactions/create-manual.ts`:

```typescript
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { normalizeMerchant } from "../merchants/normalize.js";
import { dateKeyInTz } from "../tz/date.js";

export type CreateManualTxInput = {
  merchantRaw: string;
  amount: number;
  occurredAt?: string;       // YYYY-MM-DD; defaults to today in user tz
  categoryId?: string;
  note?: string;
  accountId?: string;
};

export type CreateManualTxResult = {
  transaction: {
    id: string;
    amount: string;          // serialized Decimal
    currency: string;
    merchantRaw: string;
    merchantNormalized: string;
    categoryId: string | null;
    occurredAt: string;       // ISO
    note: string | null;
    source: "manual";
    accountId: string;
    createdAt: string;
  };
};

export class CreateManualTxError extends Error {
  constructor(public code:
    | "invalid_amount"
    | "invalid_date"
    | "invalid_note"
    | "invalid_merchant"
    | "category_not_found"
    | "account_not_found"
  ) {
    super(code);
  }
}

export async function createManualTransactionService(
  ctx: { workspaceId: string; userTz: string },
  input: CreateManualTxInput,
): Promise<CreateManualTxResult>;
```

Internals (sketch):

1. **Validate merchantRaw**: trim, reject empty or > 200 chars → `invalid_merchant`.
2. **Validate amount**: must be a finite number > 0 and ≤ 999_999_999.99 → `invalid_amount`.
3. **Validate note**: if provided and > 1000 → `invalid_note`.
4. **Resolve date**: if `occurredAt` provided, regex-validate `^\d{4}-\d{2}-\d{2}$`, then `new Date(occurredAt + "T12:00:00Z")` and assert `!isNaN(d.getTime())` AND `d.toISOString().slice(0,10) === occurredAt` (round-trip check rejects `2026-05-32` etc.). On failure → `invalid_date`. If not provided, use `dateKeyInTz(new Date(), ctx.userTz)` to get today's YYYY-MM-DD in the user's tz, then anchor at UTC noon (matches 1E-time policy).
5. **Validate categoryId**: if provided, `findFirst({ id, workspaceId, archivedAt: null })`. → `category_not_found`.
6. **Resolve account**:
   - If `input.accountId`: `findFirst({ id, workspaceId, plaidItemId: null })`. → `account_not_found` if not found OR if `plaidItemId IS NOT NULL`.
   - Else: `findFirst({ workspaceId, plaidItemId: null })`. If none, auto-create:
     ```typescript
     await prisma.bankAccount.create({
       data: {
         workspaceId,
         name: "Cash",
         type: "depository",
         currency: workspace.currency,
         status: "active",
       },
     });
     ```
7. **Read workspace.currency**: `await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { currency: true } })`. Needed for `Transaction.currency` and (if creating the manual account) `BankAccount.currency`.
8. **Insert Transaction**:
   ```typescript
   await prisma.transaction.create({
     data: {
       workspaceId,
       accountId: account.id,
       plaidItemId: null,
       plaidTransactionId: null,
       amount: new Prisma.Decimal(input.amount),
       currency: workspace.currency,
       merchantRaw: trimmedMerchantRaw,
       merchantNormalized: normalizeMerchant(trimmedMerchantRaw),
       categoryId: input.categoryId ?? null,
       occurredAt: occurredAtUtc,
       postedAt: null,
       pending: false,
       source: "manual",
       rawData: {},
       note: input.note ?? null,
       categorizationSource: input.categoryId ? "manual" : null,
     },
   });
   ```

9. **Return serialized row** matching `CreateManualTxResult`.

---

## 6. Route module

`apps/api/src/routes/transactions.ts` — add handler:

```typescript
const ManualTxBody = z.object({
  merchantRaw: z.string(),
  amount: z.number(),
  occurredAt: z.string().optional(),
  categoryId: z.string().optional(),
  note: z.string().optional(),
  accountId: z.string().optional(),
});

fastify.post("/workspaces/:id/transactions/manual", async (req, reply) => {
  const ctx = await requireWorkspaceContext(req, reply, "editor");
  if (!ctx) return;
  if (req.params.id !== ctx.workspaceId) {
    return reply.code(400).send({ error: "workspace_mismatch" });
  }
  const parsed = ManualTxBody.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body" });
  }
  try {
    const result = await createManualTransactionService(
      { workspaceId: ctx.workspaceId, userTz: ctx.userTz },
      parsed.data,
    );
    return reply.code(201).send(result);
  } catch (err) {
    if (err instanceof CreateManualTxError) {
      const status = err.code.startsWith("invalid_") ? 400 : 404;
      return reply.code(status).send({ error: err.code });
    }
    throw err;
  }
});
```

**No Pro gate.** All tiers (Free/Lite/Pro) can POST.

---

## 7. Files

- **Modify** `apps/api/prisma/schema.prisma` — add `Workspace.currency`
- **Create** `apps/api/prisma/migrations/<ts>_add_workspace_currency/migration.sql`
- **Create** `apps/api/src/transactions/create-manual.ts`
- **Modify** `apps/api/src/routes/transactions.ts` — add POST handler
- **Create** `apps/api/tests/transactions.create-manual.test.ts` (~12 cases)

No new dependencies.

---

## 8. Tests (~12 cases)

### Service-level (`createManualTransactionService`)

1. **Auto-creates "Cash" manual account on first call.** Workspace has no
   `plaidItemId IS NULL` account. Result: account auto-created with
   `name="Cash"`, `type="depository"`, `currency=workspace.currency`,
   `plaidItemId=null`. Transaction attached to it.
2. **Reuses existing manual account on second call.** Two calls → both
   transactions attached to the same auto-created account.
3. **Explicit `accountId` works when `plaidItemId IS NULL`.**
4. **Explicit `accountId` from another workspace → `account_not_found`.**
5. **Explicit `accountId` with `plaidItemId` set → `account_not_found`.**
6. **`amount: 0` → `invalid_amount`.** Also test `-5`, `NaN` (via cast),
   `1_000_000_000` (over cap).
7. **`occurredAt: "2026-13-01"` → `invalid_date`.** Also `"not-a-date"`,
   `"2026-05-32"`.
8. **`occurredAt` omitted → defaults to today (UTC noon).** Uses `userTz`.
9. **`categoryId` archived → `category_not_found`.**
10. **`note` > 1000 chars → `invalid_note`.**
11. **Transaction.currency inherits Workspace.currency.** Set
    `Workspace.currency = "USD"`; assert `Transaction.currency === "USD"`.

### Route-level (HTTP, included in same test file)

12. **POST 201 for Free-tier user.** Create user with `trialEndsAt = NOW() - INTERVAL '1 day'` and `trialConsumed = true` → still gets 201, not 402.

---

## 9. Acceptance criteria

1. Migration applies cleanly on both `fina` and `fina_test` DBs.
2. All ~12 test cases pass.
3. Auto-created BankAccount has the documented shape.
4. Free-tier users can POST (no 402).
5. baseline 82/681 → **83 files / ~693 tests**. No regressions.
6. No new dependency.

---

## 10. Excluded scope

- `editTransaction`, `deleteTransaction` HTTP routes.
- `addTransaction` chat tool.
- CSV import.
- HTTP-route audit logging (deferred to `1C-audit-http`).
- Multi-currency Budget/RecurringExpense reconciliation (deferred to `1C-currency-unify`).
- Manual account naming UX ("Cash" hardcoded; UI track owns rename later).
- Manual account `plaid_account_id` (always null for manual rows).

---

## 11. Follow-up candidates

- **Plan 1C-edit-transaction:** `PATCH /transactions/:id` for note + category updates on manual rows.
- **Plan 1C-delete-transaction:** `DELETE /transactions/:id` with soft-delete (`removedAt`).
- **Plan 1C-currency-unify:** Drop or deprecate per-row `currency` columns; centralize on `Workspace.currency`; add Budget/RecurringExpense currency inheritance + cross-currency display.
- **Plan 1C-audit-http:** Add audit hooks to non-chat HTTP routes (manual tx, recurring CRUD, etc.).
- **Plan 1C-csv-import:** Bulk manual import from CSV.
