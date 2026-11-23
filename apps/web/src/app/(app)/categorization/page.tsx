"use client";

import { useCallback, useEffect, useState } from "react";
import { PatchMeBody, type CategorizationMode, type MeDTO } from "@fina/shared";
import { apiFetch } from "../../../lib/api";
import styles from "../finance.module.css";

const modes: Array<{ key: CategorizationMode; title: string; description: string }> = [
  {
    key: "flexible",
    title: "Flexible",
    description: "New merchants need one confirmation. Skipping is fine.",
  },
  {
    key: "strict",
    title: "Strict",
    description: "Confirm every merchant before Fina categorizes automatically.",
  },
  {
    key: "auto",
    title: "Automatic",
    description: "Fina categorizes without asking. You can fix mistakes in Activity.",
  },
];

export default function CategorizationPage() {
  const [me, setMe] = useState<MeDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setMe(await apiFetch<MeDTO>("/me"));
      setError(null);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load settings.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function choose(mode: CategorizationMode) {
    if (!me || busy) return;
    const body = PatchMeBody.parse({ categorizationMode: mode });
    setBusy(true);
    setError(null);
    try {
      setMe(await apiFetch<MeDTO>("/me", { method: "PATCH", body: JSON.stringify(body) }));
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not save setting.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Activity settings</div>
          <h1 className={styles.title}>Categorization style</h1>
          <p className={styles.sub}>Choose how Fina confirms transaction categories.</p>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div className={styles.cards}>
        {modes.map((mode) => (
          <button
            key={mode.key}
            type="button"
            className={`${styles.cardButton} ${me?.user.categorizationMode === mode.key ? styles.cardSelected : ""}`}
            disabled={busy || !me}
            onClick={() => void choose(mode.key)}
          >
            <strong className={styles.cardTitle}>
              {mode.title}
              {me?.user.categorizationMode === mode.key ? " ✓" : ""}
            </strong>
            <span className={styles.cardMeta}>{mode.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
