// Password policy + UI strength meter. Single source of truth so the
// API minimum, the web sign-up minLength, and the mobile + web strength
// meters all move together.

/** Minimum password length enforced by Better Auth + every sign-up form. */
export const MIN_PASSWORD_LENGTH = 8;

/** 4-level strength label. Driven by length + complexity (mixed case +
 *  digits + symbols) so callers get enough granularity for a useful meter.
 *  Returned as a plain string; each UI maps to its own copy / color / %. */
export type PasswordStrength = "weak" | "fair" | "good" | "strong";

/** UI strength meter. Returns `null` for empty input so the meter can be
 *  hidden until the user types something.
 *
 *  Scoring (each +1):
 *   - length ≥ 8 (the policy minimum)
 *   - length ≥ 12
 *   - mixed case (at least one lower and one upper)
 *   - contains a digit
 *   - contains a non-alphanumeric character
 *
 *  Buckets:
 *   - score ≤ 1 → weak   (renders red — below policy or barely meets it)
 *   - score = 2 → fair   (renders amber)
 *   - score = 3 → good   (renders blue)
 *   - score ≥ 4 → strong (renders green) */
export function passwordStrength(pw: string): PasswordStrength | null {
  if (pw.length === 0) return null;
  let score = 0;
  if (pw.length >= MIN_PASSWORD_LENGTH) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return "weak";
  if (score === 2) return "fair";
  if (score === 3) return "good";
  return "strong";
}

/** Boolean variant matching the API's actual policy (length-only). Don't
 *  add complexity rules here without also updating Better Auth + tests. */
export function meetsPasswordPolicy(pw: string): boolean {
  return pw.length >= MIN_PASSWORD_LENGTH;
}
