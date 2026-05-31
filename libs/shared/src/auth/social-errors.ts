/** Stable codes for social/OAuth sign-in failures. These are CLIENT-side
 *  Better Auth / native-module results, NOT REST ApiError codes — they never
 *  travel through apiFetch/isApiError, so they live in their own union. */
export const SOCIAL_AUTH_ERRORS = [
  "oauth_failed",
  "oauth_cancelled",
  "apple_signin_unavailable",
] as const;

export type SocialAuthError = (typeof SOCIAL_AUTH_ERRORS)[number];

/** Classify a Better Auth client error object, a thrown native (Apple /
 *  WebBrowser) result, or anything else into one stable code so web + mobile
 *  render identical copy. */
export function classifySocialAuthError(e: unknown): SocialAuthError {
  const obj = (e ?? {}) as {
    code?: string;
    type?: string;
    message?: string;
    error?: { code?: string; message?: string };
  };
  const code = typeof obj.code === "string" ? obj.code : obj.error?.code ?? "";
  // Read the message without coercion — a hostile `.toString()` must not throw
  // (this function's contract is "classify ANYTHING, never blow up while
  // rendering copy"); a non-string message is treated as empty.
  const raw = obj.message ?? obj.error?.message;
  const message = typeof raw === "string" ? raw : "";

  if (
    obj.type === "cancel" ||
    code === "ERR_REQUEST_CANCELED" ||
    code === "ERR_CANCELED" ||
    // Broad on purpose: a swallowed cancel (silent no-op) is better UX than a
    // spurious error toast on user back-out, and real OAuth failure messages
    // (invalid_grant / access_denied / network) don't contain "cancel".
    /cancel/i.test(message)
  ) {
    return "oauth_cancelled";
  }
  if (/not available|unavailable/i.test(message) || code === "ERR_APPLE_AUTHENTICATION_UNAVAILABLE") {
    return "apple_signin_unavailable";
  }
  return "oauth_failed";
}
