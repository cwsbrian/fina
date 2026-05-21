// Canonical API error contract — every JSON error body the API returns has
// shape `{ error: <code>, message?: <string> }`. Frontend code that string-
// matches on the `code` MUST import `ApiErrorCode` here so a new code
// surfaces as a TS error in `switch (code)` exhaustiveness checks.
//
// When the API adds a new code, add it here FIRST, then update routes.

export const API_ERROR_CODES = [
  // Auth / session
  "unauthenticated",
  "no_user",
  "missing_workspace_header",
  "no_membership",
  "insufficient_role",
  "upgrade_required",

  // Workspace / membership
  "workspace_mismatch",
  "workspace_has_data",
  "already_member",
  "duplicate_invite",
  "duplicate_name",
  "last_owner",
  "not_owner",
  "same_user",
  "use_transfer",
  "wrong_email",
  "invalid_role",

  // Invite lifecycle
  "consumed",
  "revoked",
  "expired",
  "accepted",
  "email_send_failed",

  // Validation
  "invalid_body",
  "invalid_query",
  "invalid_amount",
  "invalid_period_start",
  "invalid_merchant",
  "invalid_next_date",
  "currency_mismatch",

  // Resource not-found
  "not_found",
  "thread_not_found",
  "tx_not_found",
  "category_not_found",
  "budget_not_found",
  "recurring_not_found",
  "intent_not_found",

  // Limits
  "too_many_categories",
  "plaid_item_limit_reached",

  // Domain rejections
  "forbidden",
  "intent_owner_mismatch",
  "intent_gone",

  // Plaid
  "already_connected",
  "plaid_item_not_found",
  "plaid_link_expired",
  "plaid_login_required",
  "plaid_unavailable",
  "sync_in_progress",

  // Chat
  "chat_provider_error",
  "not_member",

  // Billing
  "payment_required",
  "checkout_failed",
  "portal_failed",
  "webhook_invalid_signature",
  "webhook_handler_failed",
  "already_subscribed",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Shape of an error thrown by the shared `apiFetch`. The `code` is one of
 * the canonical strings above; `message` is an optional human-readable
 * sentence the API may include. */
export type ApiError = {
  status: number;
  code: ApiErrorCode | `http_${number}`;
  message?: string;
};

/** Type guard. Useful in catch blocks that may receive `unknown`. */
export function isApiError(e: unknown): e is ApiError {
  return (
    typeof e === "object" &&
    e !== null &&
    "status" in e &&
    "code" in e &&
    typeof (e as { status: unknown }).status === "number" &&
    typeof (e as { code: unknown }).code === "string"
  );
}
