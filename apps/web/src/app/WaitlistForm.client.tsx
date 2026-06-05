"use client";

import React, { FormEvent, useState } from "react";

export function WaitlistForm() {
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
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (body.error === "email_not_configured") {
          setErr("Email is not configured yet. Try again later.");
          setBusy(false);
          return;
        }
        setErr(
          body.error === "invalid_email"
            ? "Enter a valid email."
            : "Something went wrong. Try again.",
        );
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
    <form className="waitlist-form" onSubmit={onSubmit}>
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
        {submitted ? "You're in" : busy ? "Joining..." : "Join waitlist"}
      </button>
      {err && <p className="waitlist-error">{err}</p>}
    </form>
  );
}
