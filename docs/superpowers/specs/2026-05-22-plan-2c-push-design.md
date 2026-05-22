# Plan 2C-push — Design

**Date:** 2026-05-22
**Status:** Draft
**Pairs with:**
- [Plan 2B-daily-brief](2026-05-21-plan-2b-daily-brief-design.md) — Brief generation that 2C delivers via push.
- Master design [fina-design §6 + §15](2026-05-07-fina-design.md) — push notifications named as the `daily ritual` wake-up channel.
- Phase 2 follow-ups: 2D-brief-ui (mobile native rendering + categorize_card routing), web push, deep linking — separate plans.

---

## 1. Goal

After a daily brief is generated in 2B, send a push notification to each of the user's registered iOS / Android devices via Expo Push. User taps notification → app launches → existing 2B unbound chat thread shows the full brief. Fire-and-forget — brief is durably stored in DB regardless of push delivery outcome.

### In scope (10 tasks expected)

| Code | Item |
|---|---|
| Shared | `RegisterDeviceBody` zod schema + `LogContext` push fields |
| Schema | New `UserDevice` table |
| API | POST `/devices` route (upsert push token) |
| API | `expo-server-sdk` dependency + `sendBriefPush()` module |
| API | `markdownToPlainPreview()` utility (brief MD → push body) |
| API | Daily-brief cron (2B): extract brief text via `briefBlocksToText(blocks)` after `$transaction` commit, then call `sendBriefPush(userId, briefText)` |
| API | `EXPO_ACCESS_TOKEN` env in `apps/api/src/env.ts` (z.string().optional()) + `.env.example` docs (free tier sends without it; recommended for production rate limits + future receipt polling) |
| Mobile | `registerForPushNotifications()` helper using `expo-notifications` |
| Mobile | Root layout wires register + tap listener |
| Tests | Integration: POST /devices, push send mocked Expo, stale-token cleanup, cron → push triggered |

### Out of scope (deferred)

| Item | Why |
|---|---|
| Deep linking (push tap → specific thread navigation) | v1 just opens the app; user clicks chat tab to see the brief. Deep link requires expo-router URL design + payload schema. Plan 2D or later. |
| Push receipt polling (Expo's 15-min delivery-confirmation API) | v1 fire-and-forget. Add when dogfooding reports "I didn't get the push". |
| Quiet hours / Do Not Disturb custom rules | OS-level DND already respected by Expo. App-level overrides v1.5+. |
| Tier-based push gating | v1 dogfooding = all users on Pro per master spec §13.11. Re-evaluate at public beta. |
| Web push (Web Push API + Service Worker) | Different infrastructure entirely. Mobile-only daily ritual per master spec §3. |
| iOS notification categories / actions (Approve/Dismiss buttons in the notification itself) | UX detour. The brief's `categorize_card` already lives inside the app per Plan 2D's scope. |
| Settings UI for push opt-out | v1 relies on OS permission toggle. App-level toggle v1.5+. |
| Sign-out → delete device row | Expo token survives sign-out and stays valid for the device. The next user signing in re-registers; the stale row becomes inert and gets cleaned by `DeviceNotRegistered` later. Minor leak; v1.5 cleanup. |

---

## 2. Shared library touchpoints

Per CLAUDE.md "When writing a design spec" rule.

### Uses (existing)
- `ApiError`, `isApiError` (`libs/shared/src/errors.ts`) — POST /devices uses existing `invalid_body` error code.

### Adds (new) — Task 1, ships in own commit before any consumer

**1. `RegisterDeviceBody` zod schema** (`libs/shared/src/schemas/devices.ts`, new file):

```ts
import { z } from "zod";

/** Body for POST /devices. Mobile sends on every launch (after permission
 *  grant + Expo token retrieval). Upserts by (userId, expoPushToken). */
export const RegisterDeviceBody = z.object({
  expoPushToken: z.string().min(1, "expoPushToken required"),
  platform: z.enum(["ios", "android"]),
}).strict();

export type RegisterDeviceBody = z.infer<typeof RegisterDeviceBody>;
```

Re-export from `libs/shared/src/index.ts`.

**2. `LogContext` extension** (`libs/shared/src/logging.ts`):

```ts
export type LogContext = {
  // ... existing fields ...
  /** Push (Plan 2C). */
  deviceCount?: number;
  pushSent?: number;
  pushFailed?: number;
  removedDeviceId?: string;
};
```

No new error codes. No new DTOs. No new constants. Push tokens / platform values are runtime data, not constants.

---

## 3. Schema additions (Task 2 — Prisma migration)

```prisma
model UserDevice {
  id              String    @id @default(cuid())
  userId          String
  /// Expo's "ExponentPushToken[xxx]" format string. Opaque to us; Expo
  /// translates to APNs (iOS) or FCM (Android) device tokens internally.
  expoPushToken   String
  /// "ios" or "android". TEXT not enum so non-target platforms (future
  /// web push, desktop, etc.) can be added without a Prisma migration.
  platform        String
  /// Updated on every register/refresh call (per app foreground / launch).
  lastSeenAt      DateTime  @default(now())
  createdAt       DateTime  @default(now())

  user            User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([userId, expoPushToken])
  @@index([userId])
  @@map("user_devices")
}
```

**Paired change in same migration**: add `devices UserDevice[]` back-reference inside the existing `model User { ... }` (alongside `briefs Brief[]` and `sessions Session[]`). Prisma validation fails if relation only exists on one side, so Task 2 must touch both sides in the same `schema.prisma` diff.

Migration backfill: not needed. Existing users have 0 devices until first launch post-deploy.

---

## 4. Architecture

```
[Mobile app launch]
    │
    ├─ Notifications.requestPermissionsAsync()   ← OS dialog
    │       └─ user grants → continue; denies → silent skip
    │
    ├─ Notifications.getExpoPushTokenAsync({ projectId })
    │       └─ "ExponentPushToken[xxxxxxxxxx]"
    │
    └─ POST /devices { expoPushToken, platform }
             ↓
[API] upsert UserDevice (UNIQUE userId+expoPushToken)


[Daily-brief cron — every minute, 2B]
    │
    ├─ buildBriefContext → generateBrief → presentation blocks
    ├─ $transaction: chatMessage.create + brief.create
    │
    └─ AFTER tx commit:
         // brief.ts already exports briefBlocksToText(blocks: unknown): string
         // which strips PresentationBlock[] JSON to plain text for the
         // anti-repetition window. Reuse it here for the push preview source.
         sendBriefPush(userId, briefBlocksToText(blocks))
             ↓
         [push/send.ts]
         ├─ devices = prisma.userDevice.findMany({ userId })
         ├─ messages = devices.map(d => ({
         │      to: d.expoPushToken,
         │      title: "Fina ☀️",
         │      body: markdownToPlainPreview(briefMarkdown, 120),
         │      data: { type: "daily-brief" },
         │      sound: "default",
         │    }))
         ├─ chunks = expo.chunkPushNotifications(messages)
         ├─ tickets = await Promise.all(chunks.map(c => expo.sendPushNotificationsAsync(c)))
         └─ for each ticket with status="error" and details.error="DeviceNotRegistered":
                prisma.userDevice.delete(...)
             ↓
         [Expo's exp.host/--/api/v2/push/send]
             ↓
         [APNs (iOS) / FCM (Android)]
             ↓
         [User's phone shows notification]


[User taps notification]
    ↓
[Mobile app launches]
    ├─ addNotificationResponseReceivedListener fires
    │       └─ v1: no-op (just opening the app is enough)
    └─ User navigates to chat tab → sees brief in unbound thread
```

### Why push send is AFTER `$transaction` commit (not inside)

- `$transaction` callback holds a DB connection. The Expo HTTP call takes 200ms-2s — holding a connection that long is bad practice under load.
- If push fails, the brief is already durable in DB. User still sees the brief on next app launch. No data loss.
- If push fails AND the transaction had also failed, no brief and no push — correct behavior.

### Why fire-and-forget (vs synchronous receipt confirmation)

- Expo's send API returns "tickets" with the immediate accept/reject result.
- True delivery confirmation requires polling `getPushNotificationReceiptsAsync` ~15 minutes later. v1 doesn't poll; it just trusts the initial ticket.
- Receipts can be added in v1.5 if dogfooding reports "I didn't get my brief on Tuesday."

---

## 5. Push body construction (Task 5)

`markdownToPlainPreview(md: string, max = 120): string`:

1. Strip markdown syntax: `*`, `_`, `#`, `` ` ``, `~`, `>` characters removed.
2. Convert `[text](url)` → `text`.
3. Collapse newlines to single spaces.
4. Trim to `max` chars; if truncated, suffix `"…"`.
5. Final `.trim()`.

Examples:
- `"좋은 아침! 어제 **Starbucks** 한 건 분류 필요해."` → `"좋은 아침! 어제 Starbucks 한 건 분류 필요해."`
- `"# 새 달이야\n\n지난달 페이스가 좋았어. ..."` → `"새 달이야 지난달 페이스가 좋았어. ..."`

Push message shape:

```ts
{
  to: "ExponentPushToken[...]",
  title: "Fina ☀️",
  body: markdownToPlainPreview(brief, 120),
  data: { type: "daily-brief" },   // future deep-link routing key
  sound: "default",
  priority: "high",                // iOS interrupt-level / Android importance
}
```

---

## 6. Stale token cleanup (Task 4)

```ts
const chunks = expo.chunkPushNotifications(messages);
for (const chunk of chunks) {
  const tickets = await expo.sendPushNotificationsAsync(chunk);
  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    if (t.status === "error" && t.details?.error === "DeviceNotRegistered") {
      // Token is permanently invalid (app uninstalled, etc.). Remove.
      // Cast required — Expo's ExpoPushMessage type doesn't include the
      // __deviceId field. We attach it when building the messages array
      // (one-off "deviceId carrier" pattern). TS: see Task 4 implementation.
      const deviceId = (chunk[i] as { __deviceId: string }).__deviceId;
      await prisma.userDevice.delete({ where: { id: deviceId } });
      logInfo({ cron, removedDeviceId: deviceId }, "stale device removed");
    } else if (t.status === "error") {
      // Other errors (MessageRateExceeded, InvalidCredentials, etc.) — log
      // and continue. Don't delete the token; it may work next time.
      logWarn({ cron, err: t.message, details: t.details }, "push send error");
    }
  }
}
```

`chunk[i].__deviceId` is an internal field we attach when building the messages array (Expo's `ExpoPushMessage` type doesn't include it; we cast).

---

## 7. Mobile flow (Tasks 8 + 9)

### `apps/mobile/src/api/push.ts` (new)

```ts
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { apiFetch } from "./client";

export async function registerForPushNotifications(): Promise<string | null> {
  // OS permission first.
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return null;  // user declined

  // Get Expo token. Expo SDK 54: projectId MUST come from either explicit
  // arg OR app.json's `extra.eas.projectId`. We pass it explicitly via
  // expo-constants to fail loudly if the field is missing in app config.
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    // Missing EAS projectId in app.json — log to dev console (best-effort)
    // and skip registration. Brief is still visible in chat thread on next
    // foreground.
    return null;
  }
  const tokenResp = await Notifications.getExpoPushTokenAsync({ projectId });
  const token = tokenResp.data;
  if (!token) return null;

  const platform = Platform.OS === "ios" ? "ios" : "android";

  // Register with backend.
  try {
    await apiFetch("/devices", {
      method: "POST",
      body: JSON.stringify({ expoPushToken: token, platform }),
    });
  } catch {
    // Silently swallow — backend may be temporarily down. Token is cached
    // by Expo locally; next launch will retry.
  }
  return token;
}
```

### `apps/mobile/app/_layout.tsx` (modified)

Add inside the root layout component, after the existing `syncDeviceTz` effect (or as a new sibling effect):

```tsx
useEffect(() => {
  registerForPushNotifications().catch(() => {});

  // V1: tap → app launch is enough. No deep-link routing.
  // Listener exists so Expo doesn't complain about unhandled notifications.
  const sub = Notifications.addNotificationResponseReceivedListener(() => {
    // No-op. Future: route to specific chat thread based on payload.data.
  });
  return () => sub.remove();
}, []);
```

### `app.json` / `expo.config.ts` — push capability declaration

Mobile app config needs:

```json
{
  "expo": {
    "ios": {
      "infoPlist": {
        "NSUserNotificationsUsageDescription": "Fina sends a daily morning brief notification."
      }
    },
    "android": {
      "permissions": ["NOTIFICATIONS"]
    },
    "plugins": [
      ["expo-notifications", {
        "icon": "./assets/notification-icon.png",
        "color": "#000000"
      }]
    ],
    "extra": {
      "eas": {
        "projectId": "<set via `eas init` or paste from expo.dev/accounts/<acct>/projects/<project>>"
      }
    }
  }
}
```

`extra.eas.projectId` is REQUIRED for `getExpoPushTokenAsync({ projectId })` in Expo SDK 54. Run `eas init` (Expo CLI) on the mobile project once to populate it automatically; or paste the value from the Expo dashboard. Without this field, the mobile helper short-circuits and returns null (no push, but app still works). Verify current `app.json` shape and add only missing fields.

---

## 8. Error handling / edge cases

- **User denies push permission**: `registerForPushNotifications` returns `null`. No `UserDevice` row created. Brief still emits to chat thread; user sees it on next app launch (no notification wake-up). Acceptable.
- **Expo Push service down**: `sendPushNotificationsAsync` throws. Outer `try/catch` in daily-brief.ts catches; logError logged. Brief already in DB. User unaffected on next launch.
- **Token rotation** (rare — Expo regenerates tokens on certain OS updates): mobile re-registers on next launch; UPSERT creates new row. Old row's token will fail with `DeviceNotRegistered` on next send and get cleaned.
- **App reinstalled with new token**: same as token rotation. Old row cleaned via `DeviceNotRegistered`.
- **Sign-out + different sign-in on same device**: see §1 out-of-scope note. v1 leaves the old row; next send cleans via `DeviceNotRegistered`.
- **Push permission granted but Expo `getExpoPushTokenAsync` throws** (network error, EXPO_PROJECT_ID misconfigured): mobile helper catches; `null` returned; no register. Retried next launch.
- **Concurrent registers from same device** (race during launch): unique `(userId, expoPushToken)` constraint makes upsert idempotent.
- **Multi-account device** (user A signs out, user B signs in on same physical device): user B registers their own UserDevice row with same expoPushToken under their userId. User A's row remains until `DeviceNotRegistered` (token never expires for valid app installs; row stays inert). Acceptable v1.

---

## 9. Testing strategy

| Test | Surface |
|---|---|
| POST /devices — upsert (create then update) | Integration |
| POST /devices — validation rejects malformed body | Integration |
| POST /devices — requires session (401 if anon) | Integration |
| sendBriefPush — mocks Expo SDK; assert chunked call shape | Integration with mocked `@expo/server-sdk` |
| sendBriefPush — DeviceNotRegistered → row deleted | Integration |
| sendBriefPush — other error → row preserved, warn logged | Integration |
| sendBriefPush — zero devices → no-op (logs zero count) | Integration |
| markdownToPlainPreview — strips MD, truncates, ellipsis | Pure unit |
| Cron tick: brief emitted → sendBriefPush invoked | Integration with mocked Expo + brief mocks |
| Cron tick: push throws → brief still durable in DB | Integration |

Goal: 100% spec §3-§7 coverage. No `vi.spyOn(prisma, ...)` (memory rule). Use manual save/restore where direct Prisma method substitution is unavoidable.

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `EXPO_PROJECT_ID` unset on mobile → `getExpoPushTokenAsync` throws | Medium | Mobile helper swallows the throw; returns null. Surface a one-time devlog warning. |
| Expo Push service rate limits (Expo Push max ~600 req/sec) | Low at dogfooding scale | Daily brief is 1 send per user per day. 100 users = 100 sends spread over hours = no rate concern. |
| `EXPO_ACCESS_TOKEN` (optional Expo auth for higher rate limits + receipt access) missing | Low | Spec adds it as `z.string().optional()` in env.ts. Free tier (no token) works for dogfooding. |
| Stale `UserDevice` rows accumulate (multi-account device, no sign-out cleanup) | Low | `DeviceNotRegistered` cleanup runs on every send. Worst case: 1 stale row per device-account swap until next send. Acceptable. |
| Mobile push permission UX rejected → "why didn't I get my brief?" | Medium (UX) | Brief is also visible in chat thread; not pure regression. Settings UI in 2D / 2E could expose toggle. |
| User on flight mode at brief time → push lost | Low | OS queues push briefly. Expo doesn't retry forever. Acceptable: user opens chat tab to see brief. |
| Tap → app launch but user lands on home tab, not chat | Medium (UX) | v1 explicit out-of-scope. Plan 2D / 2E adds deep link routing. |

---

## 11. Success criteria

After all 10 tasks land and merge:

- Sign-in on mobile + grant permission → `UserDevice` row exists with that user's expoPushToken.
- Cron daily-brief → assistant ChatMessage created → `sendBriefPush` invoked → mocked Expo accepts → log shows `pushSent: 1`.
- Mocked Expo returns `DeviceNotRegistered` for a token → corresponding `UserDevice` row deleted, log shows `removedDevice`.
- `markdownToPlainPreview` test suite covers strip + truncate + ellipsis cases.
- `tsc --noEmit` clean across `@fina/shared`, `@fina/api`, `@fina/mobile`.
- Full vitest suite ≥1030 pass (1027 pre-2C + ~5-10 new).

---

## 12. Follow-ups (post-2C)

- **2D-brief-ui** — mobile rendering of `categorize_card`, `schedule_summary`, `quick_replies` presentation block types + push tap deep-linking into specific chat thread.
- **2E-brief-settings** — mobile + web settings UI for morningTime / snoozeUntil / pauseEnabled (already in MeDTO from 2B) + push opt-out toggle.
- **2F-chat-streaming** — SSE for LLM token streaming in chat (separate concern; not push).
- **v1.5: push receipt polling** — `getPushNotificationReceiptsAsync` 15-min after send, flag actual delivery failures (vs. accepted-by-Expo).
- **v1.5: sign-out device cleanup** — `DELETE /devices` route called from mobile before clearing session cookie.
- **v1.5: web push** — Web Push API + Service Worker. Different stack entirely. Useful when web becomes a daily-use surface (not v1 per master spec §3).
- **v1.5: notification categories / actions** — iOS Approve/Dismiss buttons in the notification banner itself, e.g., one-tap categorize. Requires `categorize_card` deep linking from 2D first.
