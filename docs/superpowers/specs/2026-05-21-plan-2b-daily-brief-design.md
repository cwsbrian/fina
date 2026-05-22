# Plan 2B-daily-brief — Design

**Date:** 2026-05-21
**Status:** Draft
**Pairs with:**
- [Plan 2-chat-user-scope](2026-05-20-plan-2-chat-user-scope-design.md) — the lazy-binding thread model that 2B targets (`workspaceId IS NULL` threads).
- Phase 2 follow-ups: **2C-push** (Expo Push notifications) and **2D-brief-ui** (mobile UI badges / native rendering) are separate plans. 2B is backend-only.
- Master design [fina-design §6](2026-05-07-fina-design.md) — "Daily Morning Ritual" is the canonical reference. 2B implements that section, with two deviations resolved during brainstorming (see §11).

---

## 1. Goal

Generate and deliver a personalized morning brief to each Fina user on their schedule. Backend cron picks users whose local time matches their `morningTime`, builds a multi-workspace financial context, sends it through Gemini, and emits the LLM's `PresentationBlock[]` response as a new assistant message in the user's **unbound** chat thread. Three cadences (daily / weekly / monthly), highest cadence wins on collision days. Always emit a message — even on "nothing newsworthy" days, the brief is encouragement, not silence.

### In scope (10 tasks expected)

| Code | Item |
|---|---|
| Schema | New `Brief` table + 3 `User` columns (`morningTime`, `snoozeUntil`, `pauseEnabled`) |
| Shared | `MeDTO` extension + PATCH /me zod body schema for the 3 new fields |
| API | PATCH /me handler updates the new fields |
| Mobile + Web | Device tz auto-sync — `PATCH /me { tz }` on app launch / sign-in |
| Cron | New `daily-brief` job (every minute) |
| LLM | New `brief.ts` (reuses `turn.ts` helpers — financial context builder, presentation block emitter) |
| Tool | New `pauseDailyBrief` chat tool |
| Test | Per-task unit + integration coverage |

### Out of scope (deferred)

| Item | Why |
|---|---|
| Push notifications | Plan 2C — own surface (Expo Push registration, device token table, notification triggers). Brief is observable via chat thread + logs in 2B alone. |
| Mobile UI badges / native brief cards | Plan 2D — mobile-side rendering work. 2B's brief lands in the existing chat thread, viewable through the existing chat UI. |
| Tier gating (Free / Lite / Pro brief differences) | v1 dogfooding = all users on Pro per master spec §13.11. Re-evaluate at public beta. |
| Workspace-scoped brief option | Brief is always user-scoped (multi-workspace aggregate). v2 may add per-workspace brief subscriptions. |
| Last-year-same-month trend | dogfooding users lack 1 year of data. Add in v1.5 when data is available. |
| `briefStyle` user preference (concise / encouraging / etc.) | YAGNI for v1 — single personality. v1.5 if dogfooding asks. |
| Brief retry on LLM failure | Cron's `safe()` (1H) logs the error; next day's run tries again. One missed brief is acceptable. |
| Per-brief idempotency at minute precision | `briefs UNIQUE(userId, date)` is enough. If cron double-fires the same minute, the second INSERT fails benignly. |

---

## 2. Shared library touchpoints

Per CLAUDE.md "When writing a design spec" — every spec lists what the feature uses from `@fina/shared` and what new shared exports it creates.

### Uses (existing shared)

- `MeDTO` (`libs/shared/src/dto/me.ts`) — extension target.
- PATCH /me request schema (`libs/shared/src/schemas/me.ts` if exists; create if not) — extension target.
- `ChatThreadDTO`, `ChatMessageDTO`, `PresentationBlock` (`libs/shared/src/dto/chat.ts`) — message emit shape.
- `LogContext` (`libs/shared/src/logging.ts`, 1H) — cron observability.
- `ApiError` / `isApiError` / `ApiErrorCode` (`libs/shared/src/errors.ts`) — PATCH /me validation errors via existing codes.

### Adds (new shared) — Task 1, ships in own commit before any consumer

**1. `MeDTO` field additions** (`libs/shared/src/dto/me.ts`):

```ts
export type MeDTO = {
  // ... existing fields ...
  morningTime: string;        // "HH:mm", e.g. "08:00"
  snoozeUntil: string | null; // ISO date string, e.g. "2026-05-28"
  pauseEnabled: boolean;
};
```

**2. PATCH /me body schema** (`libs/shared/src/schemas/me.ts`):

```ts
import { z } from "zod";

export const PatchMeBody = z.object({
  // Existing fields stay; add three optional partial-update fields:
  morningTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  snoozeUntil: z.string().date().nullable().optional(),
  pauseEnabled: z.boolean().optional(),
  tz: z.string().optional(),  // device tz auto-sync (also new — Task 4)
}).strict();
export type PatchMeBody = z.infer<typeof PatchMeBody>;
```

If `me.ts` schema file doesn't exist yet, create it; otherwise extend.

**No new** error codes, DTOs, constants. Brief-related collisions (snoozed user, duplicate same-day) are internal to cron — logged but not exposed to consumers.

### Presentation block extension (existing — not new)

The `categorize_card` presentation block ships its `workspaceId` so the user's tap routes to the correct workspace. Verify the existing `categorize_card` type in `libs/shared/src/dto/chat.ts` already has a `workspaceId` field; if not, add it as a Task 1 sub-step (single field, no breaking change because existing chat is single-workspace).

---

## 3. Architecture

Every minute, the cron picks users whose local time matches their stored `morningTime` and have no Brief row for today. For each, it determines the brief type (1st of month = monthly, Monday = weekly, else = daily), builds the multi-workspace financial context, loads recent brief texts for anti-repetition, calls Gemini with a brief-specific system prompt and **no tools**, then emits the returned `PresentationBlock[]` as an assistant message in the user's unbound chat thread (`workspaceId IS NULL`). The brief is recorded in `briefs(userId, date)` for idempotency.

### Cadence rule (highest wins)

```
let today = ISO date in user's tz
let dayOfMonth = day-of-month in user's tz
let dayOfWeek  = day-of-week  in user's tz (0=Sun..6=Sat)

if dayOfMonth === 1     → "monthly"
else if dayOfWeek === 1 → "weekly"
else                    → "daily"
```

Result: each user receives exactly one brief per day. `briefs UNIQUE(userId, date)` guarantees this.

### Multi-workspace aggregation

The brief is **user-scoped**, not workspace-scoped. Context builder fetches data across **all** the user's active memberships and presents per-workspace breakdowns to the LLM. Most v1 dogfooding users have 1-2 workspaces (personal + family); v1.5 may add a "top N busiest workspaces" cap for users with many memberships.

Why user-scoped? Plan 2-chat-user-scope's lazy binding rule: the brief lands in an **unbound** thread (`workspaceId IS NULL`). When the user replies, the thread binds to whichever workspace they chose for the reply. The brief itself cannot pre-commit to a workspace because the user's "primary" workspace is undefined in a multi-membership model.

---

## 4. Schema additions (Task 2 — Prisma migration)

### `User` model — 3 new columns

```prisma
model User {
  // ... existing fields ...

  /// Time-of-day (user-local) when daily brief fires. "HH:mm" 24h format.
  /// Default 08:00. Validated by zod regex `^([01]\d|2[0-3]):[0-5]\d$`.
  morningTime   String    @default("08:00")

  /// Skip brief generation until this date (ISO date, user-local). Null when
  /// not snoozed. Stored as full DateTime for sortability; the date-portion
  /// in user.tz is what counts.
  snoozeUntil   DateTime?

  /// Indefinite pause. When true, no briefs fire regardless of snoozeUntil.
  /// Explicit boolean (not snoozeUntil = far future) so the UI can render a
  /// clear toggle.
  pauseEnabled  Boolean   @default(false)
}
```

### New `Brief` model + enum

```prisma
enum BriefType {
  daily
  weekly
  monthly
}

model Brief {
  id        String    @id @default(cuid())
  userId    String
  type      BriefType
  /// ISO date string (YYYY-MM-DD) in the user's tz at generation time. Stored
  /// as text (not DateTime) so the date-portion comparison is exact even if
  /// the user's tz changes between briefs.
  date      String
  messageId String    @unique
  createdAt DateTime  @default(now())

  user    User        @relation(fields: [userId], references: [id], onDelete: Cascade)
  message ChatMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@unique([userId, date])
  @@index([userId, type, date])
  @@map("briefs")
}
```

Migration ships in its own commit (Task 2). Backfill: existing users get default `morningTime = "08:00"` automatically (Prisma `@default`); `snoozeUntil` is null; `pauseEnabled` is false.

---

## 5. Brief context per type

The context builder (`apps/api/src/chat/brief-context.ts`, Task 5) produces a structured object per brief type. All numeric values are pre-formatted (currency, percentage); the LLM doesn't need to compute.

| Field | Daily | Weekly (Monday, non-1st) | Monthly (1st of month) |
|---|---|---|---|
| **Transactions** | New in last 24h (per workspace) | Last 7 days summary + per-day counts | Last month full summary |
| **Uncategorized** | Yesterday's | Last 7 days accumulated | Last month + carry-over |
| **Schedule** | Today + this week + this month upcoming | This week + this month upcoming | This month + next month upcoming |
| **Budget progress** | This week + this month % spent | This month % spent | This month + last month vs budget |
| **Recurring** | Next 7 days due | Next 4 weeks due | Next 30 days due |
| **Deviation** | This-week pace vs budget | Last week vs prior week | Last month vs this month |
| **Year-over-year** | — | — | Out of scope for v1 (deferred) |
| **Anti-repetition** | Last 3 daily brief texts | Last 2 weekly brief texts | Last 2 monthly brief texts |

### Anti-repetition

Recent brief message texts are injected into the LLM system prompt as `recent_briefs: string[]` with instruction: "이전 N일 brief은 이렇게 작성됐어. 어조와 표현을 다르게 해줘." ~300 tokens / message × 3 = ~900 tokens added to daily brief input. Negligible cost.

### Per-workspace breakdown shape

The context object groups data by workspace so the LLM can produce workspace-aware messages:

```ts
type BriefContext = {
  user: { id, name, tz, morningTime };
  briefType: "daily" | "weekly" | "monthly";
  date: string;  // YYYY-MM-DD in user tz
  workspaces: Array<{
    id: string;
    name: string;
    currency: string;
    transactions: { newCount, uncategorizedCount, sample: TxSummary[] };
    schedule: ScheduledItem[];
    budget: BudgetProgress[];
    recurring: RecurringItem[];
    deviation: { thisWeekPct, /* etc */ };
  }>;
  recentBriefs: string[];  // anti-repetition
};
```

---

## 6. Data flow (cron tick)

```
matchUsers = SELECT u, u.tz, u.morningTime
             FROM users u
             WHERE NOT u.pauseEnabled
               AND (u.snoozeUntil IS NULL OR u.snoozeUntil < NOW())
               AND timeMatchesNowInTz(u.morningTime, u.tz)
               AND NOT EXISTS (
                 SELECT 1 FROM briefs b
                 WHERE b.userId = u.id AND b.date = dateInTz(NOW(), u.tz)
               )

for each user in matchUsers (sequential, awaited inside safe() wrapper):
  briefType = determineBriefType(dateInTz(NOW(), u.tz))
  context   = await buildBriefContext(u.id, briefType)
  recent    = await loadRecentBriefs(u.id, briefType, n=3)
  blocks    = await generateBrief(context, recent, briefType)   // brief.ts
  thread    = await findOrCreateUnboundThread(u.id)
  msg       = await prisma.chatMessage.create({ threadId: thread.id, role: "assistant", blocks })
  await prisma.brief.create({
    userId: u.id, type: briefType, date: dateInTz(NOW(), u.tz), messageId: msg.id
  })
  logInfo({ cron: "daily-brief", userId: u.id, briefType, msgId: msg.id }, "brief emitted")
```

All paths wrapped in 1H's `safe()` so an LLM failure for one user logs + skips, the next user still runs.

### `findOrCreateUnboundThread(userId)`

```ts
let thread = await prisma.chatThread.findFirst({
  where: { userId, workspaceId: null, archivedAt: null },
  orderBy: { createdAt: "desc" },
});
if (!thread) {
  thread = await prisma.chatThread.create({ data: { userId, workspaceId: null } });
}
return thread;
```

If an unbound thread exists, append to it (Plan 2-chat-user-scope rule). The thread accumulates daily briefs until the user replies, then binds to whichever workspace they choose. Next day's brief finds no unbound thread → creates new one.

---

## 7. Components / tasks (rough outline)

| # | Task | Files |
|---|---|---|
| 1 | `@fina/shared` extension (MeDTO + PatchMeBody + categorize_card.workspaceId) | `libs/shared/src/dto/me.ts`, `schemas/me.ts`, `dto/chat.ts` |
| 2 | Prisma migration (User + Brief + BriefType) | `apps/api/prisma/schema.prisma`, `prisma/migrations/...` |
| 3 | PATCH /me handler — accept morningTime / snoozeUntil / pauseEnabled / tz | `apps/api/src/routes/me.ts` |
| 4 | Device tz auto-sync on app launch | `apps/mobile/src/api/auth.ts`, `apps/web/src/lib/auth.ts` |
| 5 | `brief-context.ts` — multi-workspace context builder | `apps/api/src/chat/brief-context.ts` |
| 6 | `brief.ts` — LLM call (reuses turn.ts helpers; no tool calls) | `apps/api/src/chat/brief.ts` |
| 7 | `daily-brief.ts` — cron job (every minute) | `apps/api/src/cron/jobs/daily-brief.ts`, register in `scheduler.ts` |
| 8 | `pauseDailyBrief` chat tool | `apps/api/src/chat/tools/pause-daily-brief.ts`, register in `chat/tools/index.ts` |
| 9 | Integration tests (per-type, snooze, pause, collision day, multi-workspace) | `apps/api/tests/cron.daily-brief.test.ts`, `chat.brief.test.ts`, `routes.me.test.ts` |
| 10 | E2E smoke — real cron tick → brief in thread | `apps/api/tests/cron.daily-brief.e2e.test.ts` |

Implementation order: 1 (shared) → 2 (schema) → 3 (PATCH route) → 4 (clients) → 5 (context) → 6 (brief.ts) → 7 (cron) → 8 (tool) → 9-10 (tests).

---

## 8. Error handling / edge cases

- **Cron double-fire**: `briefs UNIQUE(userId, date)` — second INSERT throws; cron catches + logs (no duplicate message).
- **LLM failure**: `safe()` catches; this user's brief is missed today, next day retries.
- **Invalid `User.tz`**: `resolveUserTz` (1J) falls back to `America/Toronto`.
- **`PATCH /me { tz }` race with cron**: if user lands in new tz mid-day and the new tz makes their morningTime already-past, the cron's `timeMatchesNowInTz` check is exact-minute — they don't double-receive; tomorrow's brief uses the new tz cleanly.
- **User with 0 active memberships**: no workspaces means no financial context. Brief becomes pure encouragement ("아직 workspace 없어 - 가족 초대해봐"). Acceptable degraded mode.
- **User reply mid-brief-generation**: thread binds during cron's INSERT. The brief is still emitted to the (now bound) thread. Next day's brief creates a new unbound thread. Acceptable.
- **`snoozeUntil` in the past at cron time**: treated as "not snoozed" (SQL `< NOW()` excludes the row from the snooze filter).
- **`categorize_card` workspaceId routing**: the LLM may emit cards from multiple workspaces in one brief. Each card carries its `workspaceId`. Frontend (Plan 2D) routes the tap to the correct workspace.

---

## 9. Testing strategy

| Test | Surface |
|---|---|
| Cadence determination — 1st, Monday, weekday, Monday×1st collision | Pure function, unit |
| `timeMatchesNowInTz` — UTC and non-UTC users at minute precision | Pure function, unit |
| `findOrCreateUnboundThread` — existing vs missing | Integration (real DB) |
| Context builder — single + multi-workspace | Integration (seeded fixtures) |
| `brief.ts` — LLM mocked; assert presentation blocks emitted; per-type prompt selection | Integration with mocked Gemini |
| Cron tick — full pipeline (seed user → fire cron → message in thread, briefs row exists) | Integration |
| Snooze / pause — both prevent emission | Integration |
| `briefs UNIQUE` collision — second INSERT throws cleanly | Integration |
| `pauseDailyBrief` chat tool — updates User.snoozeUntil correctly | Integration |
| Anti-repetition context — last 3 brief texts injected | Unit (context shape) |

Goal: 100% spec coverage. No `vi.spyOn(prisma, ...)` patterns (memory rule).

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Every-minute cron load | Low | Filter SELECT has `WHERE NOT pauseEnabled AND NOT EXISTS (briefs)`. Indexed. Returns 0 rows ~99% of the minute. |
| LLM cost | Low | ~$0.0006 / user / day = $1.80 / 100 users / month at Gemini Flash-Lite. |
| Multi-workspace context bloat (5+ memberships) | Low | v1 dogfooding users have 1-2. v1.5 may add "top N" cap. |
| Device tz drift (traveling user, app not opened yet) | Low | First app launch after travel triggers `PATCH /me { tz }`. Worst case: 1 brief in old tz. |
| Anti-repetition injecting stale tone | Low | LLM-judgment. If tone gets repetitive, increase N (3 → 5) in v1.5. |
| Empty-financial-context brief feels hollow | Medium | LLM prompt explicitly handles "no new activity" — produces encouragement. Dogfooding will validate. |
| `categorize_card` from one workspace tap-routed to wrong workspace | Low | Card payload carries `workspaceId`; frontend (Plan 2D) routes precisely. Add card-level integration test in Plan 2D. |

---

## 11. Deviations from master spec §6

Two design decisions during 2B brainstorming deviate from the canonical fina-design §6:

1. **Always emit a message (no "별 거 없으면 skip" rule).** Master spec said skip when nothing newsworthy. We always emit because: (a) the cost difference (LLM call vs no call) is ~$0.0006 — negligible, (b) the ritual value (consistent daily message, app-opening habit) outweighs the noise risk, (c) "오늘 메시지 없네?" confuses the user. Encouragement / well-wishes on quiet days is the design.

2. **3 brief types (daily / weekly / monthly), highest wins.** Master spec described a single "daily" ritual. We split into 3 cadences because they carry meaningfully different context (last 24h vs last 7 days vs last month). On collision days (Monday × 1st = monthly only), the higher cadence absorbs the lower (LLM context can include "어제" within "last month").

Master spec §6 will be updated in a follow-up doc commit referencing this plan.

---

## 12. Success criteria

After all 10 tasks land and merge to main:

- A user with default `morningTime = "08:00"` in `America/Toronto` receives a brief message in their chat thread at the next 08:00 ET.
- The brief lands in an unbound thread (existing or freshly created).
- `briefs UNIQUE(userId, date)` prevents duplicate same-day emission.
- `PATCH /me { snoozeUntil: "2026-05-28" }` skips brief generation for 7 days.
- `pauseDailyBrief({ indefinite: true })` chat tool sets `User.pauseEnabled = true`.
- Monthly brief (1st of month) includes last-month transaction summary; weekly brief (Monday) includes last-7-days; daily includes yesterday.
- Multi-workspace user gets per-workspace breakdown in the brief.
- LLM tone differs day-to-day on quiet days (anti-repetition works).
- All `pnpm --filter @fina/api exec vitest run` tests pass.
- `tsc --noEmit` clean across `@fina/shared`, `@fina/api`, `@fina/web`, `@fina/mobile`.

---

## 13. Follow-ups (post-2B)

- **2C-push** — Expo Push token registration + push trigger on brief emission. Reads from `briefs` table or hooks into the brief.ts emit path.
- **2D-brief-ui** — Mobile native rendering of brief presentation blocks (categorize_card, schedule_summary, quick_replies). May include unread badge on chat tab.
- **2E-brief-settings** — Mobile + web settings UI for morningTime / snoozeUntil / pauseEnabled (reads/writes via PATCH /me).
- **v1.5: year-over-year trend** in monthly brief once dogfooding users have 1 year of data.
- **v1.5: `briefStyle` user preference** — concise / encouraging / data-heavy.
- **v2: workspace-scoped brief subscriptions** — power users with many workspaces opt-in per-workspace brief.
