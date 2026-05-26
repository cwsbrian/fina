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
  msgId?: string;
  /** Cron */
  cron?: string;
  event?: "start" | "protected_skip" | "success" | "fail";
  durationMs?: number;
  /** Brief cron */
  briefType?: "daily" | "weekly" | "monthly";
  /** Plaid */
  plaidEvent?: string;
  plaidItemId?: string;
  /** Audit log linkage */
  auditAction?: string;
  /** Error context. Pino accepts Error directly (serializes message +
   *  stack); pass other shapes if no Error is available. */
  err?: unknown;
  /** Push (Plan 2C). */
  deviceCount?: number;
  pushSent?: number;
  pushFailed?: number;
  /** UserDevice.id removed after Expo returned DeviceNotRegistered. */
  removedDeviceId?: string;
  /** Sign-out cleanup (Plan 2C-push-cleanup). deleteMany count
   *  (보통 0 또는 1; 0이어도 audit trail로 로깅). */
  removedDeviceCount?: number;
  /** Receipt polling cron (Plan 2C-push-receipts). */
  receiptsPolled?: number;
  receiptsFailed?: number;
  receiptInvalidCreds?: boolean;
  receiptErrorCode?: string;
  deletedPushTickets?: number;
  /** Fan-out push helpers (Plan 1U): per-recipient failure context. */
  recipientUserId?: string;
  goalId?: string;
  transactionId?: string;
  /** Goal milestone cron: percentage crossed. */
  pct?: number;
};
