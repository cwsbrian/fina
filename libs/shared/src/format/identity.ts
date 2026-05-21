// Identity-display helpers. Pure functions; safe to use from API logging,
// web UI, and mobile UI alike.

/** 2-char avatar text for a user. Trims and uppercases. Falls back to email
 *  if `name` is empty/null/undefined. Returns "?" if both are unusable.
 *
 *  Examples:
 *    initials("Brian Choi", "x@t.co") → "BC"
 *    initials(null, "brian.choi@t.co") → "BC"  (split on space/@/dot)
 *    initials(null, "x@t.co") → "X"            (single token)
 *    initials("Brian", "x@t.co") → "BR"        (first two chars of one token)
 */
export function initials(name: string | null | undefined, email: string): string {
  const source = name?.trim() || email;
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/** First space-delimited token of `name`. Falls back to the email local-part.
 *  Used for "Hi {firstName}" greetings — never throws. */
export function displayName(user: { name: string | null; email: string }): string {
  const trimmed = user.name?.trim();
  if (trimmed) return trimmed.split(/\s+/)[0]!;
  return localPartOfEmail(user.email);
}

/** Returns the part of an email address before the `@`. Used as a default
 *  user name on sign-up and as the workspace name on bootstrap. */
export function localPartOfEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}
