// Cross-app constants. Always import from `@fina/shared` — do not redefine
// these strings in apps/web or apps/mobile.

/** HTTP header that workspace-scoped routes read to pin the request to a
 * specific workspace. Chat routes (post Plan 2-chat-user-scope) ignore this
 * header and read workspaceId from the request body instead. */
export const WORKSPACE_HEADER = "x-workspace-id";

/** Stable app-install identifier sent by mobile clients. The API uses this
 * for per-device integrity throttles, not for authentication. */
export const CLIENT_DEVICE_ID_HEADER = "x-fina-device-id";

/** Mobile platform for the current install. Kept separate from user-agent so
 * server-side billing logic can reason about native store ownership. */
export const CLIENT_PLATFORM_HEADER = "x-fina-platform";

/** Storage key for the user's last-selected workspace id. Cookie on web,
 * AsyncStorage on mobile. Same name across apps so the docs / debug tools
 * line up. */
export const ACTIVE_WORKSPACE_STORAGE_KEY = "fina-active-workspace";

/** Default workspace currency. Mirrors `Workspace.currency` Prisma default. */
export const DEFAULT_CURRENCY = "CAD";

/** Default user timezone. Mirrors `User.tz` Prisma default. */
export const DEFAULT_TZ = "America/Toronto";

/** Per-route rate-limit policies. Keys map 1:1 to logical buckets;
 * the API's `withRateLimit(key)` helper translates these into the
 * @fastify/rate-limit plugin config. Frontend may import for
 * client-side "X requests remaining" UI later. */
export const RATE_LIMITS = {
  /** Default for any route without an explicit override. Keyed by IP.
   *  Bumped from 60 → 600/min — the mobile app fires several parallel
   *  fetches on every screen focus (transactions + categories +
   *  schedules + recurring + budget, etc.), and the previous cap
   *  surfaced spurious 429s during normal navigation. */
  globalDefault: { max: 600, windowMs: 60_000 },
  /** Heaviest cost — guards LLM token spend. Keyed by user id. */
  chatMessages: { max: 60, windowMs: 60_000 },
  /** Credential-stuffing protection — sign-in / sign-up only. 5 attempts per
   *  minute per IP is realistic for humans and slows automated guessing to
   *  near-zero throughput. Wired by server.ts onto /api/auth/sign-in/* and
   *  /api/auth/sign-up/* (Plan 1J Task 8). */
  authStrict: { max: 5, windowMs: 60_000 },
  /** All other /api/auth/* paths (get-session, list-sessions, sign-out, etc.).
   *  30/min/IP accommodates Better Auth's get-session polling fired on every
   *  page load by the web client. 5/min was too tight — a logged-in user
   *  would hit 429 after ~5 page navigations. (Was 5/min in plan 1H; raised
   *  to 30 in hotfix 4108020 and reaffirmed here as the long-term value.) */
  auth: { max: 30, windowMs: 60_000 },
  /** Plaid Link callback / re-exchange. Keyed by user id. */
  plaidExchange: { max: 5, windowMs: 60_000 },
} as const;

export type RateLimitKey = keyof typeof RATE_LIMITS;
