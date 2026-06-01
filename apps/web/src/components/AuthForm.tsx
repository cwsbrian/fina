"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  MIN_PASSWORD_LENGTH,
  meetsPasswordPolicy,
  classifySocialAuthError,
  type InvitePreview as InvitePreviewDTO,
} from "@fina/shared";
import { signIn, signUp } from "../auth/client";
import { apiFetch } from "../lib/api";
import { env } from "../env";
import { AuthTopBar } from "./AuthTopBar";
import { SocialButton } from "./SocialButton";
import { WebIcon } from "./WebIcon";
import styles from "./auth.module.css";

type InvitePreview = Pick<InvitePreviewDTO, "status" | "invitedEmail">;

type Mode = "signIn" | "signUp";

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const search = useSearchParams();
  const fromParam = search?.get("from") ?? "";
  const safeFrom =
    fromParam.startsWith("/") && !fromParam.startsWith("//") ? fromParam : null;
  const inviteToken = search?.get("inviteToken") ?? null;
  const [lockedEmail, setLockedEmail] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);

  // Preserve query params (from, inviteToken) across the mode toggle so the
  // user keeps their context when bouncing /sign-in ↔ /sign-up.
  const qs = (() => {
    const sp = new URLSearchParams();
    if (safeFrom) sp.set("from", safeFrom);
    if (inviteToken) sp.set("inviteToken", inviteToken);
    return sp.toString() ? `?${sp.toString()}` : "";
  })();
  const otherPath = mode === "signUp" ? `/sign-in${qs}` : `/sign-up${qs}`;
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
    if (mode === "signUp" && name.trim().length === 0) {
      setErr("Please enter your name.");
      return;
    }
    if (!meetsPasswordPolicy(password)) {
      setErr(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
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
              name: name.trim(),
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
          name: name.trim(),
        });
        if (r.error) {
          if (
            r.error.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" ||
            /already/i.test(r.error.message ?? "")
          ) {
            throw new Error(
              "This email is already registered. Sign in instead?",
            );
          }
          throw new Error(r.error.message ?? "Sign up failed");
        }
        // Backend has emailOTP({ sendVerificationOnSignUp: true }) — code
        // already sent. Route to verify-email; /home redirects post-verify.
        router.replace(`/verify-email?email=${encodeURIComponent(email)}`);
        return;
      } else {
        const r = await signIn.email({ email, password });
        if (r.error) {
          if (
            r.error.code === "EMAIL_NOT_VERIFIED" ||
            /verif/i.test(r.error.message ?? "")
          ) {
            router.replace(
              `/verify-email?email=${encodeURIComponent(email)}`,
            );
            return;
          }
          throw new Error(r.error.message ?? "Sign in failed");
        }
      }
      router.replace(safeFrom ?? "/home");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Auth failed");
    } finally {
      setBusy(false);
    }
  }

  async function social(provider: "google" | "apple") {
    setErr(null);
    const callbackURL = `${window.location.origin}${safeFrom ?? "/home"}`;
    try {
      const res = await signIn.social({ provider, callbackURL });
      if (res.error) {
        const code = classifySocialAuthError(res.error);
        if (code !== "oauth_cancelled")
          setErr("Couldn't sign in. Please try again.");
      }
      // On success Better Auth navigates to the provider's consent screen, then
      // back to callbackURL.
    } catch (e) {
      // Rare: a throw before the redirect (parity with mobile's report()).
      if (classifySocialAuthError(e) !== "oauth_cancelled")
        setErr("Couldn't sign in. Please try again.");
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
                <label className={styles.fieldLabel}>Name</label>
                <input
                  className={styles.input}
                  placeholder="Your name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
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
              disabled={busy || !email || !meetsPasswordPolicy(password)}
            >
              {busy ? "…" : mode === "signUp" ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className={styles.divider}>or</div>

          <div className={styles.socialStack}>
            <SocialButton provider="google" label="Continue with Google" onClick={() => social("google")} />
            <SocialButton provider="apple" label="Continue with Apple" onClick={() => social("apple")} />
          </div>

          {mode === "signUp" && (
            <p className={styles.legal}>
              By creating an account, you agree to our{" "}
              <a href="/terms" target="_blank" rel="noopener noreferrer">
                Terms
              </a>{" "}
              and{" "}
              <a href="/privacy" target="_blank" rel="noopener noreferrer">
                Privacy policy
              </a>
              .
            </p>
          )}

          <div className={styles.foot}>
            {mode === "signUp" ? (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => router.push(otherPath)}
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
                  onClick={() => router.push(otherPath)}
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
