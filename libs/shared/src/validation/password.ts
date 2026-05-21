// Password policy + UI strength meter. Single source of truth so the
// API minimum, the web sign-up minLength, and the mobile strength meter
// all move together.

/** Minimum password length enforced by Better Auth + every sign-up form. */
export const MIN_PASSWORD_LENGTH = 8;

export type PasswordStrength = "weak" | "okay" | "strong";

/** UI strength meter. Returns `null` for empty input so the meter can be
 *  hidden until the user types something. */
export function passwordStrength(pw: string): PasswordStrength | null {
  if (pw.length === 0) return null;
  if (pw.length < MIN_PASSWORD_LENGTH) return "weak";
  if (pw.length < 12) return "okay";
  return "strong";
}

/** Boolean variant matching the API's actual policy (length-only). Don't
 *  add complexity rules here without also updating Better Auth + tests. */
export function meetsPasswordPolicy(pw: string): boolean {
  return pw.length >= MIN_PASSWORD_LENGTH;
}
