"use client";

import { FormEvent, useState } from "react";
import styles from "./page.module.css";

export default function Landing() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email || submitted || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErr(body.error === "invalid_email" ? "Enter a valid email." : "Something went wrong. Try again.");
        setBusy(false);
        return;
      }
      setSubmitted(true);
    } catch {
      setErr("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.top}>
        <img
          src="/images/logo-dark.png"
          alt="Fina"
          className={styles.logo}
        />
        <div className={styles.topMeta}>Opening summer 2026</div>
      </div>

      <div className={styles.center}>
        <div className={styles.eyebrow}>Now accepting early access</div>
        <h1 className={styles.headline}>
          Every morning,
          <br />
          <em>before</em> you open your wallet.
        </h1>
        <p className={styles.sub}>
          Fina, your financial companion for everyday money. We&apos;re
          opening the waitlist in small batches.
        </p>
        <form className={styles.form} onSubmit={onSubmit}>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitted || busy}
            required
            aria-label="Email address"
          />
          <button type="submit" disabled={submitted || busy || email.length === 0}>
            {submitted ? "You're in ✓" : busy ? "Joining…" : "Join waitlist"}
          </button>
        </form>
        {err && (
          <p style={{ marginTop: 12, color: "var(--color-down)", fontSize: 14 }}>
            {err}
          </p>
        )}
      </div>

      <div className={styles.foot}>
        <span>© 2026 Fina, Inc.</span>
        <span>Privacy</span>
        <span>Terms</span>
      </div>
    </main>
  );
}
