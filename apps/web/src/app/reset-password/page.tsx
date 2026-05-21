"use client";

import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  MIN_PASSWORD_LENGTH,
  meetsPasswordPolicy,
  passwordStrength,
  type PasswordStrength,
} from "@fina/shared";
import { authClient } from "../../auth/client";
import { AuthTopBar } from "../../components/AuthTopBar";
import { WebIcon } from "../../components/WebIcon";
import styles from "../../components/auth.module.css";

// UI presentation for the 4-level shared strength scale. Logic lives in
// @fina/shared/passwordStrength; this map is pure CSS metadata.
const STRENGTH_UI: Record<
  PasswordStrength,
  { pct: number; label: string; color: string }
> = {
  weak: { pct: 30, label: "Weak", color: "var(--color-down)" },
  fair: { pct: 55, label: "Fair", color: "#f4b000" },
  good: { pct: 80, label: "Good", color: "var(--color-primary)" },
  strong: { pct: 100, label: "Strong", color: "var(--color-up)" },
};

const STRENGTH_EMPTY = {
  pct: 0,
  label: "",
  color: "var(--color-muted)",
};

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className={styles.page} />}>
      <ResetPasswordInner />
    </Suspense>
  );
}

function ResetPasswordInner() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");

  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const strengthLevel = passwordStrength(pw);
  const strength = strengthLevel ? STRENGTH_UI[strengthLevel] : STRENGTH_EMPTY;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (!meetsPasswordPolicy(pw)) {
      setErr(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (pw !== pw2) {
      setErr("Passwords don't match.");
      return;
    }
    if (!token) {
      setErr(
        "Missing reset token. Open the link from your email again, or request a new one.",
      );
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const result = await authClient.resetPassword({
        newPassword: pw,
        token,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Could not update password");
      }
      setDone(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not update password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <AuthTopBar homePath="/sign-in" />
      <div className={styles.body}>
        <div className={styles.card}>
          {!done ? (
            <>
              <h1 className={styles.title}>Set a new password</h1>
              <p className={styles.sub}>
                Choose something at least 8 characters long. You&apos;ll stay
                signed in on this device.
              </p>
              <form onSubmit={submit}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>New password</label>
                  <div className={styles.fieldTrail}>
                    <input
                      className={styles.input}
                      type={show ? "text" : "password"}
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      placeholder="At least 8 characters"
                      autoComplete="new-password"
                      autoFocus
                    />
                    <button
                      type="button"
                      className={styles.fieldTrailIcon}
                      onClick={() => setShow((s) => !s)}
                      aria-label={show ? "Hide password" : "Show password"}
                    >
                      <WebIcon name={show ? "eyeOff" : "eye"} size={16} />
                    </button>
                  </div>
                  {pw && (
                    <div className={styles.strengthRow}>
                      <div className={styles.strengthBar}>
                        <div
                          className={styles.strengthFill}
                          style={{
                            width: `${strength.pct}%`,
                            background: strength.color,
                          }}
                        />
                      </div>
                      <span
                        className={styles.strengthLabel}
                        style={{ color: strength.color }}
                      >
                        {strength.label}
                      </span>
                    </div>
                  )}
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    Confirm new password
                  </label>
                  <input
                    className={styles.input}
                    type={show ? "text" : "password"}
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                    placeholder="Type it again"
                    autoComplete="new-password"
                  />
                </div>
                {err && (
                  <div
                    className={`${styles.fieldHelper} ${styles.fieldHelperError}`}
                    style={{ marginBottom: 14 }}
                  >
                    {err}
                  </div>
                )}
                <button
                  type="submit"
                  className={styles.btn}
                  disabled={busy || !pw || !pw2}
                >
                  {busy ? "…" : "Update password"}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className={styles.successGlyph}>
                <WebIcon name="check" size={28} strokeWidth={2.2} />
              </div>
              <h1 className={styles.title}>Password updated</h1>
              <p className={styles.sub}>
                Sign in with your new password to get back to Fina.
              </p>
              <button
                type="button"
                className={styles.btn}
                onClick={() => router.replace("/sign-in")}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
