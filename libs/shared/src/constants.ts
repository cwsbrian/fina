// Cross-app constants. Always import from `@fina/shared` — do not redefine
// these strings in apps/web or apps/mobile.

/** HTTP header that workspace-scoped routes read to pin the request to a
 * specific workspace. Chat routes (post Plan 2-chat-user-scope) ignore this
 * header and read workspaceId from the request body instead. */
export const WORKSPACE_HEADER = "x-workspace-id";

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
  /** Default for any route without an explicit override. Keyed by IP. */
  globalDefault: { max: 60, windowMs: 60_000 },
  /** Heaviest cost — guards LLM token spend. Keyed by user id. */
  chatMessages: { max: 30, windowMs: 60_000 },
  /** Credential stuffing protection. Keyed by IP. 30/min still defeats any
   *  realistic password-guessing attempt while accommodating Better Auth's
   *  /api/auth/get-session polling (fired on every page load by the web
   *  client). 5/min was too tight — a logged-in user would hit 429 after
   *  ~5 page navigations. */
  auth: { max: 30, windowMs: 60_000 },
  /** Plaid Link callback / re-exchange. Keyed by user id. */
  plaidExchange: { max: 5, windowMs: 60_000 },
} as const;

export type RateLimitKey = keyof typeof RATE_LIMITS;
