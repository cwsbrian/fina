# Fina — Project Rules for AI / Frontend Contributors

This file is read by Claude Code (and any compatible AI agent) and serves
as the canonical "how we build things in this repo" document. Keep it
short, current, and aggressively rule-shaped. Long-form rationale lives
in `docs/superpowers/specs/`.

> **Repo layout**: pnpm + Nx monorepo. `apps/api` (Fastify + Prisma),
> `apps/web` (Next.js), `apps/mobile` (Expo / React Native),
> `libs/shared` (`@fina/shared` — types, schemas, validators, errors,
> HTTP client factory).

---

## Hard rule — `@fina/shared` is the source of truth

When the API exposes a shape and the frontend consumes it, the type goes
in `@fina/shared`. Never re-declare API response/request types inline
in `apps/web/**` or `apps/mobile/**` — import from `@fina/shared`.

If you find yourself writing this in an app:

```ts
type Me = { user: { id; email; ... }; tier; trial; ... };
type Workspace = { id; name; role: "owner" | "editor" | "viewer" };
type Member = { userId; email; name; role };
```

**Stop.** These exist as `MeDTO`, `WorkspaceSummary`, `Member` in
`@fina/shared`. Import them. If the shape you need genuinely doesn't
exist there, add it to `@fina/shared` first, then import.

This applies to:

| Concept | Shared as |
|---|---|
| `GET /me` response | `MeDTO` |
| `GET /workspaces` row | `WorkspaceSummary` |
| `GET /workspaces/:id/members` row | `Member` |
| `GET /workspaces/:id/invites` row | `Invite` |
| `GET /invites/by-token/:token` body | `InvitePreview` |
| Chat thread (post Plan 2-chat-user-scope) | `ChatThreadDTO` |
| Chat message | `ChatMessageDTO` |
| Assistant presentation block (text / confirm_card / …) | `PresentationBlock` |
| Transaction + its allocations | `TransactionDTO`, `AllocationDTO` |
| Category | `CategoryDTO` |
| Bank account | `BankAccountDTO` |
| Plaid item connection | `PlaidItemDTO`, `PlaidItemStatus` |
| Role / Tier / `EffectiveTier` | `Role`, `Tier`, `EffectiveTier` |
| Per-tier limits (Plaid item count, …) | `TIER_LIMITS` |

---

## HTTP transport rules

### Active workspace + cookie

- Storage key on web (cookie) and mobile (AsyncStorage) is
  `ACTIVE_WORKSPACE_STORAGE_KEY` — import from `@fina/shared`. Do
  **not** hardcode `"fina-active-workspace"` or `"fina.activeWorkspaceId"`
  anywhere new.
- The HTTP header name workspace-scoped routes read is
  `WORKSPACE_HEADER` (`x-workspace-id`). Same — import, don't hardcode.

### `/chat/*` routes ignore the workspace header

Plan 2-chat-user-scope (merged 2026-05-20) moved chat routes to
`/chat/*` and made them user-scoped. The `X-Workspace-Id` header is
**ignored** on every `/chat/*` route. Workspace context travels in
the request body of `POST /chat/threads/:tid/messages` (`workspaceId`
field). Don't add it to a `/chat/*` request; the server ignores it.

### `apiFetch`

Both apps share `makeApiFetch` from `@fina/shared`. Each app
constructs an `apiFetch` once and re-exports:

```ts
// apps/web/src/lib/api.ts
export const apiFetch = makeApiFetch({
  baseUrl: env.NEXT_PUBLIC_API_URL,
  getActiveWorkspaceId,    // sync, reads cookie
  withCredentials: true,   // browser cookie auth
});

// apps/mobile/src/api/client.ts
export const apiFetch = makeApiFetch({
  baseUrl: env.EXPO_PUBLIC_API_URL,
  getActiveWorkspaceId,    // async, AsyncStorage
  getCookieHeader: () => authClient.getCookie() ?? null,
});
```

Frontend pages always import `apiFetch` from `../lib/api` (web) or
`../src/api/client` (mobile). **Do not call `fetch()` directly to the
API** — you'll lose error normalisation, the workspace header, and the
body-less content-type workaround.

---

## Error code rules

Every JSON error body from the API has shape `{ error: <code>,
message?: <string> }`. The frontend matches on `code`.

- The **canonical union** of all error codes lives at
  `@fina/shared/errors.ts` as `ApiErrorCode`.
- When the API returns a new error code, add it to `API_ERROR_CODES`
  FIRST. The TS compiler will then highlight every frontend `switch
  (code) { case "..." }` that needs updating.
- Use the `ApiError` type and the `isApiError(e)` guard in catch
  blocks. Don't string-match against `(e as Error).message`.

```ts
import { isApiError } from "@fina/shared";

try { await apiFetch(...) } catch (e) {
  if (!isApiError(e)) throw e;
  switch (e.code) {
    case "workspace_mismatch": ...
    case "not_member": ...
    // exhaustive — TS errors if a new code is added without a case here
  }
}
```

---

## Form-validation rules

Backend zod schemas live in `@fina/shared/schemas/`. Frontend forms
should validate against the **same** schema before submitting, so the
local error message and the server's `invalid_body` rejection
correspond.

```ts
import { ChatMessageBody } from "@fina/shared";

const parsed = ChatMessageBody.safeParse(formValues);
if (!parsed.success) { ... show local error ... }
else { await apiFetch("/chat/threads/X/messages", { method: "POST", body: JSON.stringify(parsed.data) }); }
```

Schemas available today: `chat`, `budgets`, `recurring`, `schedules`,
`categories`, `invites`, `workspaces`. Add more here when new API
write routes ship.

---

## Numeric / date validation rules

For money amounts (every `Transaction.amount`, `Budget.amount`,
`RecurringExpense.amount`, `ScheduledSpend.amount`):

- `MAX_AMOUNT` is `999_999_999.99` — `Decimal(14, 2)` cap. Import from
  `@fina/shared`. Don't hardcode literals.
- `AMOUNT_RE` is `/^\d+(\.\d{1,2})?$/`. Use it for form-level "enter a
  valid amount" gating.
- `validateAmount(n)` throws `MoneyValidationError("invalid_amount")` —
  for use in services / form submission. `isValidAmount(n)` is the
  boolean variant for live UI gating.

For dates the user types as `YYYY-MM-DD`:

- `parseOccurredAt(s)` throws `DateValidationError("invalid_date")` and
  returns a UTC-noon `Date`. `isValidDate(s)` is the boolean variant.
- `DATE_RE` is exported for `<input pattern>` use.

The API's `transactions/validators.ts` still re-throws as
`TxValidationError` (its existing class) — it imports the constants
from `@fina/shared`. Don't introduce a new `MAX_AMOUNT` literal in any
file: `grep -rn '999_999_999\.99\|99_999_999\.99' apps/` should match
**nothing**.

For passwords:

- `MIN_PASSWORD_LENGTH` is `8`. `meetsPasswordPolicy(pw)` is the
  boolean used by every sign-up form + the API minimum check.
- `passwordStrength(pw)` returns `"weak" | "okay" | "strong" | null`
  for UI strength meters. App-side adapters can map to UI-specific
  labels ("Weak"/"Okay"/"Strong" capitalized).

## Identity / display helpers

Use these from `@fina/shared/format/identity.ts` for any UI that
renders user-friendly text from a user record:

- `initials(name, email)` → 2-char avatar text. Falls back to email.
- `displayName(user)` → first space-delimited token of `name`, else
  email local-part. Use for "Hi {firstName}".
- `localPartOfEmail(email)` → text before `@`. Used as default
  workspace name on bootstrap, default name on sign-up.

## Tier UI helpers

From `@fina/shared/tier.ts`:

- `tierLabel(tier, trialActive)` → `"Pro trial" | "Pro" | "Lite" | "Free"`
  for badges and settings copy.
- `trialDaysLeft(endsAt)` → whole days remaining, `0` if past,
  `null` if missing. Accepts ISO string or Date.
- `TIER_LIMITS[tier]` → per-tier caps (`plaidItems`, etc.).
- `isProFeature(feature)` → boolean gate for advisor/chat/plan
  features (currently always true for non-Free).

---

## Enums / string-literal unions

Don't redeclare these unions:

| Union | Source |
|---|---|
| `Cadence` (monthly / semimonthly / biweekly / weekly / yearly) | `@fina/shared` |
| `BudgetPeriod` (this_month / last_month / next_month) | `@fina/shared` |
| `BasicPeriod` (today / this_week / this_month / last_month) | `@fina/shared` |
| `ScheduledSpendStatus` (upcoming / unresolved / resolved-matched / resolved-dismissed) | `@fina/shared` |
| `ChatMessageRole` (user / assistant / tool) | `@fina/shared` |
| `Role` (owner / editor / viewer) | `@fina/shared` |
| `Tier` (free / lite / pro) | `@fina/shared` |
| `PlaidItemStatus` | `@fina/shared/dto/plaid.ts` |

Each is exported alongside a `const FOO = [...] as const` array — use
that when you need the runtime values (e.g., for a `<select>` or
zod `z.enum`).

---

## Web ↔ Mobile parity rule

If you add a feature to `apps/web` that the user also expects on
mobile (or vice versa), the response shape MUST go through
`@fina/shared`. Two separate ad-hoc declarations is how drift starts.

Exceptions where DUPLICATION is fine:
- React components (web's CSS-modules vs. mobile's StyleSheet diverge
  by necessity)
- Auth client setup (Better Auth `expoClient` vs. plain — different
  storage / different plugins)
- Icon renderers (SVG on web, vector on RN)

Everything else: shared.

---

## When adding a new API endpoint

1. **Spec the request/response shape in `@fina/shared` first.** Define
   the request schema in `libs/shared/src/schemas/<resource>.ts` and
   the response DTO in `libs/shared/src/dto/<resource>.ts`. Export from
   `index.ts`.
2. **Mirror the schema in the API route.** Import it; `safeParse` it;
   return DTO-shaped JSON.
3. **Add the route's error codes to `API_ERROR_CODES`** in
   `libs/shared/src/errors.ts`. Surface 400/403/404/etc. on the route
   with those codes.
4. **Add an integration test** in `apps/api/tests/`. Real DB, no mocks
   of Prisma.
5. **Then** consume from web / mobile via `apiFetch<ResponseDTO>(...)`.

Order matters: write the shape first so the API and frontend can't
disagree. If you're feeling rushed: pause, add to shared, then
continue.

---

## When writing a design spec

Every design spec under `docs/superpowers/specs/` MUST include a
**"Shared library touchpoints"** section near the top (after Goal,
before Architecture). The section answers two questions:

1. **What `@fina/shared` exports does this spec USE?** List existing
   types, constants, schemas, validators, error codes the feature
   depends on (so reviewers see the contract upfront).
2. **What shared additions does this spec CREATE?** Any new shape,
   schema, error code, constant, or helper that:
   - Has 2+ consumers (or imminent consumers) across api/web/mobile, OR
   - Should have a single source of truth even with 1 consumer
     (error codes, request schemas, money/date validators, UI display
     helpers, environment constants).

   For each addition: target file (`libs/shared/src/...`), exported
   name, brief shape, motivation.

If section 2 is empty, the spec author must explicitly note "No
shared additions needed" with a one-line reason. Don't skip the
section.

The implementation plan repeats this list in its file structure
table, ensuring shared changes ship in their own commit BEFORE any
app-side migrations.

### Brainstorming gate

Before locking the spec, the brainstorming dialogue itself must ask:

> "What request/response shapes, error codes, validation rules, UI
> display helpers, or constants does this feature add — and will
> any be consumed by 2+ apps (api/web/mobile) now or later?"

Default assumption: API response shape ≥ 1 → almost always means a
new DTO. A new error code → register in `ApiErrorCode` union. A new
request body validator → add zod schema. A literal magic number /
string used in two places → constant. Bias toward "share it".

---

## Anti-patterns (do not do)

- ❌ `type Me = { user: { ... }; tier: "free" | "lite" | "pro"; ... }`
  inline in a page component
- ❌ `fetch(env.NEXT_PUBLIC_API_URL + "/...", { ... })` — use `apiFetch`
- ❌ `const MAX_AMOUNT = 99_999_999.99` — import from `@fina/shared`
- ❌ `if ((e as Error).message === "workspace_mismatch")` — use
  `isApiError(e) && e.code === "workspace_mismatch"`
- ❌ `if (err?.code === "string_typo_no_one_will_catch")` — use the
  `ApiErrorCode` union so typos are TS errors
- ❌ `headers: { "x-workspace-id": "..." }` literal — import
  `WORKSPACE_HEADER`
- ❌ `document.cookie = "fina-active-workspace=..."` literal — import
  `ACTIVE_WORKSPACE_STORAGE_KEY`
- ❌ Duplicating `@@unique` membership check pattern in a route — call
  `prisma.membership.findUnique({ where: { userId_workspaceId: ... } })`

---

## Where to read more

- Backend architecture & phase plan: `docs/superpowers/specs/2026-05-07-fina-design.md`
- Chat thread model (most recent: Plan 2): `docs/superpowers/specs/2026-05-20-plan-2-chat-user-scope-design.md`
- Web page inventory for the designer: `docs/superpowers/specs/2026-05-20-fina-web-ui-design.md`
- All other specs: `docs/superpowers/specs/*-design.md`

---

## When in doubt

Run `grep -rn "@fina/shared" apps/api/ apps/web/ apps/mobile/ | head`
to see the patterns in use. Then follow them.

---

## IAP development workflow

`react-native-iap` is a native module — it requires a custom dev client and CANNOT run under Expo Go.

- **Layout-only work** on `apps/mobile/app/plan/*` can use Expo Go; the IAP client throws "module not linked" and falls back to the empty-state.
- **Purchase flow testing** requires `eas build --profile development` once per developer to get a dev client. Load that build instead of Expo Go.
- Each iOS developer needs their own sandbox tester account (App Store Connect → Users and Access → Sandbox Testers). Login state caches per device.
- Each Android developer adds their Google account to the Play Console license-test list.
- Tailscale Funnel ([[project_mobile_dev_network]]) carries webhooks to `localhost:4000` exactly the same way it does for Plaid.
