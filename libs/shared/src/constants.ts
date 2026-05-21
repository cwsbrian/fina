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
