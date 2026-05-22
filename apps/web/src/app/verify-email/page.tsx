"use client";

import {
  ClipboardEvent,
  KeyboardEvent,
  Suspense,
  useEffect,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "../../auth/client";
import { AuthTopBar } from "../../components/AuthTopBar";
import { WebIcon } from "../../components/WebIcon";
import styles from "../../components/auth.module.css";

const OTP_LENGTH = 6;
const RESEND_SECONDS = 60;

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div className={styles.page} />}>
      <VerifyEmailInner />
    </Suspense>
  );
}

function VerifyEmailInner() {
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get("email") ?? "your email";

  const [digits, setDigits] = useState<string[]>(Array(OTP_LENGTH).fill(""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);
  const inputs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    inputs.current[0]?.focus();
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  function setAt(idx: number, value: string) {
    const v = value.replace(/[^0-9]/g, "").slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[idx] = v;
      if (v && idx === OTP_LENGTH - 1 && next.every((d) => d.length === 1)) {
        void verify(next.join(""));
      }
      return next;
    });
    if (v && idx < OTP_LENGTH - 1) {
      inputs.current[idx + 1]?.focus();
    }
  }

  function onKeyDown(idx: number, e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const txt = e.clipboardData.getData("text").replace(/[^0-9]/g, "");
    if (txt.length === OTP_LENGTH) {
      e.preventDefault();
      const arr = txt.split("");
      setDigits(arr);
      void verify(txt);
    }
  }

  async function verify(code: string) {
    if (busy) return;
    if (!params.get("email")) {
      setErr("Missing email — go back and sign up again.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await authClient.emailOtp.verifyEmail({
        email: params.get("email")!,
        otp: code,
      });
      if (res.error) {
        throw new Error(res.error.message ?? "Code didn't match");
      }
      router.replace("/home");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not verify code");
      setDigits(Array(OTP_LENGTH).fill(""));
      inputs.current[0]?.focus();
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (cooldown > 0 || busy || !params.get("email")) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({
        email: params.get("email")!,
        type: "email-verification",
      });
      if (res.error) {
        throw new Error(res.error.message ?? "Could not resend code");
      }
      setCooldown(RESEND_SECONDS);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not resend code");
    } finally {
      setBusy(false);
    }
  }

  const mm = Math.floor(cooldown / 60);
  const ss = String(cooldown % 60).padStart(2, "0");

  return (
    <div className={styles.page}>
      <AuthTopBar homePath="/sign-in" />
      <div className={styles.body}>
        <div className={styles.card}>
          <div className={styles.successGlyph} style={{ background: "rgba(62, 179, 139,0.10)", color: "var(--color-primary)" }}>
            <WebIcon name="mail" size={26} strokeWidth={1.6} />
          </div>
          <h1 className={styles.title}>Check your email</h1>
          <p className={styles.sub}>
            We sent a 6-digit code to{" "}
            <strong style={{ color: "var(--color-ink)", fontWeight: 600 }}>
              {email}
            </strong>
            . It expires in 10 minutes.
          </p>

          <div className={styles.otpRow}>
            {digits.map((d, i) => (
              <input
                key={i}
                ref={(el) => {
                  inputs.current[i] = el;
                }}
                value={d}
                onChange={(e) => setAt(i, e.target.value)}
                onKeyDown={(e) => onKeyDown(i, e)}
                onPaste={onPaste}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={1}
                className={`${styles.otpBox} ${d ? styles.otpBoxFilled : ""}`}
                disabled={busy}
              />
            ))}
          </div>

          {err && (
            <div
              className={`${styles.fieldHelper} ${styles.fieldHelperError}`}
              style={{ marginTop: 16, textAlign: "center" }}
            >
              {err}
            </div>
          )}

          <p className={styles.foot} style={{ marginTop: 20 }}>
            {cooldown > 0 ? (
              <>
                Resend code in{" "}
                <strong style={{ color: "var(--color-body)", fontWeight: 500 }}>
                  {mm}:{ss}
                </strong>
              </>
            ) : (
              <button type="button" className={styles.link} onClick={resend}>
                Resend code
              </button>
            )}
          </p>

          <p className={styles.foot}>
            Wrong address?{" "}
            <button
              type="button"
              className={styles.link}
              onClick={() => router.replace("/sign-in")}
            >
              Change email
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

