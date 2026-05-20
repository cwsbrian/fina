"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signIn, signUp } from "../../auth/client";
import { apiFetch } from "../../lib/api";
import { env } from "../../env";
import { AuthTopBar } from "../../components/AuthTopBar";
import { WebIcon } from "../../components/WebIcon";
import styles from "../../components/auth.module.css";

type InvitePreview = {
  status: "pending" | "accepted" | "revoked" | "expired";
  invitedEmail: string;
};

export function SignInForm() {
  const router = useRouter();
  const search = useSearchParams();
  const fromParam = search?.get("from") ?? "";
  const safeFrom =
    fromParam.startsWith("/") && !fromParam.startsWith("//") ? fromParam : null;
  const inviteToken = search?.get("inviteToken") ?? null;
  const [lockedEmail, setLockedEmail] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  const [mode, setMode] = useState<"signIn" | "signUp">("signUp");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!inviteToken) return;
    apiFetch<InvitePreview>(
      `/invites/by-token/${encodeURIComponent(inviteToken)}`,
    )
      .then((p) => {
        setLockedEmail(p.invitedEmail);
        setEmail(p.invitedEmail);
      })
      .catch((e) => setPreviewErr((e as { code?: string }).code ?? "load_error"));
  }, [inviteToken]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (!email.includes("@")) {
      setErr("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (mode === "signUp" && inviteToken) {
        const res = await fetch(
          `${env.NEXT_PUBLIC_API_URL}/invites/by-token/${encodeURIComponent(inviteToken)}/sign-up`,
          {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              email,
              password,
              name: name || email.split("@")[0],
            }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            invitedEmail?: string;
            message?: string;
          };
          if (body.error === "wrong_email") {
            throw new Error(
              `This invite is for ${body.invitedEmail ?? "a different email"}. Sign up with that email to accept it.`,
            );
          }
          throw new Error(
            body.message ?? body.error ?? `Sign up failed (${res.status})`,
          );
        }
        window.location.href = safeFrom ?? "/home";
        return;
      } else if (mode === "signUp") {
        const r = await signUp.email({
          email,
          password,
          name: name || email.split("@")[0]!,
        });
        if (r.error) throw new Error(r.error.message ?? "Sign up failed");
      } else {
        const r = await signIn.email({ email, password });
        if (r.error) throw new Error(r.error.message ?? "Sign in failed");
      }
      router.replace(safeFrom ?? "/home");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <AuthTopBar homePath="/" />
      <div className={styles.body}>
        <div className={styles.card}>
          <h1 className={styles.title}>
            {mode === "signUp" ? "Create your account" : "Welcome back"}
          </h1>
          <p className={styles.sub}>
            {mode === "signUp"
              ? "Sign up and start your 30-day Pro trial. No card required."
              : "Sign in to manage your workspace, banks, and plan."}
          </p>

          {inviteToken && lockedEmail && (
            <div className={styles.banner}>
              <span className={styles.bannerIcon}>
                <WebIcon name="users" size={18} />
              </span>
              <div className={styles.bannerBody}>
                <div className={styles.bannerTitle}>Joining your workspace</div>
                <div className={styles.bannerSub}>
                  Sign up with {lockedEmail}
                </div>
              </div>
            </div>
          )}

          {previewErr && (
            <div
              className={`${styles.fieldHelper} ${styles.fieldHelperError}`}
              style={{ marginBottom: 14 }}
            >
              Could not load invite preview ({previewErr}).
            </div>
          )}

          <form onSubmit={submit}>
            {mode === "signUp" && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Name (optional)</label>
                <input
                  className={styles.input}
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  autoFocus={!inviteToken}
                />
              </div>
            )}
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Email</label>
              <div className={styles.fieldTrail}>
                <input
                  className={`${styles.input} ${lockedEmail ? styles.inputLocked : ""}`}
                  type="email"
                  placeholder="you@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  readOnly={lockedEmail !== null}
                  autoComplete="email"
                  autoFocus={mode === "signIn" && !inviteToken}
                />
                {lockedEmail && (
                  <span
                    className={styles.fieldTrailIcon}
                    style={{ pointerEvents: "none" }}
                  >
                    <WebIcon
                      name="lock"
                      size={16}
                      color="var(--color-muted-soft)"
                    />
                  </span>
                )}
              </div>
              {lockedEmail && (
                <div className={styles.fieldHelper}>
                  Email locked to the invited address. Use a different email by
                  opening <strong>/sign-in</strong> directly.
                </div>
              )}
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Password</label>
              <div className={styles.fieldTrail}>
                <input
                  className={styles.input}
                  type={showPw ? "text" : "password"}
                  placeholder={
                    mode === "signUp"
                      ? "At least 8 characters"
                      : "Your password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    mode === "signUp" ? "new-password" : "current-password"
                  }
                />
                <button
                  type="button"
                  className={styles.fieldTrailIcon}
                  onClick={() => setShowPw((s) => !s)}
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  <WebIcon name={showPw ? "eyeOff" : "eye"} size={16} />
                </button>
              </div>
              {mode === "signIn" && (
                <div className={styles.helperRow}>
                  <button
                    type="button"
                    className={`${styles.link} ${styles.linkMuted}`}
                    style={{ fontSize: 14 }}
                    onClick={() => router.push("/forgot-password")}
                  >
                    Forgot password?
                  </button>
                </div>
              )}
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
              disabled={busy || !email || password.length < 8}
            >
              {busy ? "…" : mode === "signUp" ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className={styles.divider}>or</div>

          <button
            type="button"
            className={styles.social}
            onClick={() => {
              setErr("Google sign-in is not wired yet.");
            }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
              <path
                fill="#4285F4"
                d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.79 2.71v2.25h2.9c1.7-1.56 2.69-3.87 2.69-6.6z"
              />
              <path
                fill="#34A853"
                d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.9-2.25c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"
              />
              <path
                fill="#FBBC05"
                d="M3.95 10.71c-.18-.54-.28-1.12-.28-1.71 0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l2.99-2.33z"
              />
              <path
                fill="#EA4335"
                d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96L3.95 7.29C4.66 5.16 6.65 3.58 9 3.58z"
              />
            </svg>
            Continue with Google
          </button>

          {mode === "signUp" && (
            <p className={styles.legal}>
              By creating an account, you agree to our <a>Terms</a> and{" "}
              <a>Privacy policy</a>.
            </p>
          )}

          <div className={styles.foot}>
            {mode === "signUp" ? (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => {
                    setMode("signIn");
                    setErr(null);
                  }}
                >
                  Sign in
                </button>
              </>
            ) : (
              <>
                New to Fina?{" "}
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => {
                    setMode("signUp");
                    setErr(null);
                  }}
                >
                  Create an account
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
