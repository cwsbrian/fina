/** Typed payload for the API's structured logger. Reserve keys here so
 *  typos surface as TS errors and log shape stays consistent across
 *  cron / chat / plaid / audit subsystems. */
export type LogContext = {
  /** Request-scoped */
  requestId?: string;
  userId?: string;
  /** Nullable because post-Plan-2 `ChatThread.workspaceId` is `String?` —
   *  unbound threads log `null`. */
  workspaceId?: string | null;
  /** Chat / LLM */
  threadId?: string;
  tool?: string;
  /** Cron */
  cron?: string;
  event?: "start" | "protected_skip" | "success" | "fail";
  durationMs?: number;
  /** Plaid */
  plaidEvent?: string;
  plaidItemId?: string;
  /** Audit log linkage */
  auditAction?: string;
  /** Error context. Pino accepts Error directly (serializes message +
   *  stack); pass other shapes if no Error is available. */
  err?: unknown;
};
