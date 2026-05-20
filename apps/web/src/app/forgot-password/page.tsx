"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "../../auth/client";
import { AuthTopBar } from "../../components/AuthTopBar";
import { WebIcon } from "../../components/WebIcon";
import styles from "../../components/auth.module.css";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email.includes("@") || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await authClient.requestPasswordReset({
        email: email.trim(),
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (result.error) {
        throw new Error(result.error.message ?? "Could not send reset link");
      }
      setSent(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send reset link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <AuthTopBar homePath="/sign-in" />
      <div className={styles.body}>
        <div className={styles.card}>
          {!sent ? (
            <>
              <h1 className={styles.title}>Reset your password</h1>
              <p className={styles.sub}>
                Enter the email you signed up with and we&apos;ll send a link to
                reset it.
              </p>
              <form onSubmit={submit}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Email</label>
                  <input
                    className={styles.input}
                    type="email"
                    placeholder="you@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email"
                    autoFocus
                  />
                </div>
                {err && (
                  <div className={`${styles.fieldHelper} ${styles.fieldHelperError}`} style={{ marginBottom: 14 }}>
                    {err}
                  </div>
                )}
                <button
                  type="submit"
                  className={styles.btn}
                  disabled={busy || !email.includes("@")}
                >
                  {busy ? "…" : "Send reset link"}
                </button>
              </form>
              <div className={styles.foot}>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => router.push("/sign-in")}
                >
                  Back to sign in
                </button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.successGlyph}>
                <WebIcon name="mail" size={26} strokeWidth={1.6} />
              </div>
              <h1 className={styles.title}>Check your email</h1>
              <p className={styles.sub}>
                If <strong style={{ color: "var(--color-ink)", fontWeight: 600 }}>{email}</strong> is
                registered with Fina, you&apos;ll receive a reset link within a
                minute. It expires in 30 minutes.
              </p>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnOutline}`}
                onClick={() => {
                  setSent(false);
                  setEmail("");
                }}
              >
                Use a different email
              </button>
              <div className={styles.foot}>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => router.push("/sign-in")}
                >
                  Back to sign in
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
