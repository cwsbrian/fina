"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { PatchMeBody, type MeDTO } from "@fina/shared";
import { apiFetch } from "../../../lib/api";
import styles from "../finance.module.css";

export default function BriefPage() {
  const [me, setMe] = useState<MeDTO | null>(null);
  const [time, setTime] = useState("08:00");
  const [pauseUntil, setPauseUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await apiFetch<MeDTO>("/me");
      setMe(result);
      setTime(result.user.morningTime);
      setPauseUntil(result.user.snoozeUntil ?? "");
      setError(null);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load brief settings.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function patch(body: Record<string, unknown>) {
    const parsed = PatchMeBody.safeParse(body);
    if (!parsed.success) {
      setError("Check the brief settings.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetch<MeDTO>("/me", {
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      setMe(result);
      setTime(result.user.morningTime);
      setPauseUntil(result.user.snoozeUntil ?? "");
      setNotice("Brief settings saved.");
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not save brief settings.");
    } finally {
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void patch({ morningTime: time, snoozeUntil: pauseUntil || null });
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Morning updates</div>
          <h1 className={styles.title}>Brief</h1>
          <p className={styles.sub}>
            Choose when Fina prepares your spending update. Weekly and monthly reports appear in
            chat on Pro and Max.
          </p>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className={styles.panel} role="status" style={{ padding: 14, marginBottom: 16 }}>
          {notice}
        </div>
      )}
      {!me && !error && <div className={`${styles.panel} ${styles.empty}`}>Loading settings…</div>}
      {me && (
        <form className={styles.panel} onSubmit={save}>
          <div className={styles.formGrid}>
            <div className={styles.field}>
              <label htmlFor="brief-enabled">Briefs</label>
              <select
                className={styles.input}
                id="brief-enabled"
                value={me.user.pauseEnabled ? "off" : "on"}
                onChange={(event) => void patch({ pauseEnabled: event.target.value === "off" })}
                disabled={busy}
              >
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
            <div className={styles.field}>
              <label htmlFor="brief-time">Delivery time</label>
              <input
                className={styles.input}
                id="brief-time"
                type="time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                disabled={busy}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="brief-snooze">Pause until</label>
              <input
                className={styles.input}
                id="brief-snooze"
                type="date"
                value={pauseUntil}
                onChange={(event) => setPauseUntil(event.target.value)}
                disabled={busy}
              />
              <span className={styles.muted}>Clear the date to resume.</span>
            </div>
            <div className={styles.field}>
              <label>Time zone</label>
              <span>{me.user.tz}</span>
              <a href="/settings/account">Change in Account</a>
            </div>
            <div className={styles.formActions}>
              <button className={styles.button} type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save brief settings"}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
