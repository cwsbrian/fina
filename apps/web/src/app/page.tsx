"use client";

import { FormEvent, useState } from "react";
import styles from "./page.module.css";

export default function Landing() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email || submitted) return;
    // TODO: POST /api/waitlist when endpoint exists.
    setSubmitted(true);
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
          Fina, your financial advisor. We&apos;re opening the waitlist in
          small batches.
        </p>
        <form className={styles.form} onSubmit={onSubmit}>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitted}
            required
            aria-label="Email address"
          />
          <button type="submit" disabled={submitted || email.length === 0}>
            {submitted ? "You're in ✓" : "Join waitlist"}
          </button>
        </form>
      </div>

      <div className={styles.foot}>
        <span>© 2026 Fina, Inc.</span>
        <span>Privacy</span>
        <span>Terms</span>
      </div>
    </main>
  );
}
