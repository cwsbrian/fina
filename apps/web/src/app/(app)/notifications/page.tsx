"use client";

import { useCallback, useEffect, useState } from "react";
import { PatchMeBody, type MeDTO, type NotificationPrefs } from "@fina/shared";
import { apiFetch } from "../../../lib/api";
import styles from "../finance.module.css";

const labels: Array<{ key: keyof NotificationPrefs; label: string; group: string }> = [
  { key: "morningBrief", label: "Morning brief", group: "Daily" },
  { key: "largeCharges", label: "Large or unusual charges", group: "Activity" },
  { key: "transactionAdded", label: "New transactions", group: "Activity" },
  { key: "goalMilestones", label: "Goal milestones", group: "Activity" },
  { key: "bankReconnect", label: "Bank reconnect required", group: "Account" },
  { key: "trialExpiring", label: "Trial expiring", group: "Account" },
  { key: "workspaceInvites", label: "Workspace invites", group: "Account" },
  { key: "productUpdates", label: "Product updates", group: "Updates" },
];

export default function NotificationsPage() {
  const [me, setMe] = useState<MeDTO | null>(null);
  const [busy, setBusy] = useState<keyof NotificationPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setMe(await apiFetch<MeDTO>("/me"));
      setError(null);
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not load notifications.");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(key: keyof NotificationPrefs) {
    if (!me || busy) return;
    const body = PatchMeBody.parse({
      notificationPrefs: { [key]: !me.user.notificationPrefs[key] },
    });
    setBusy(key);
    setError(null);
    try {
      setMe(await apiFetch<MeDTO>("/me", { method: "PATCH", body: JSON.stringify(body) }));
    } catch (cause) {
      setError((cause as { code?: string }).code ?? "Could not save notification preference.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.head}>
        <div>
          <div className={styles.eyebrow}>Your alerts</div>
          <h1 className={styles.title}>Notifications</h1>
          <p className={styles.sub}>Choose which updates reach your registered mobile devices.</p>
        </div>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      {!me && !error && (
        <div className={`${styles.panel} ${styles.empty}`}>Loading notifications…</div>
      )}
      {me &&
        ["Daily", "Activity", "Account", "Updates"].map((group) => (
          <section className={styles.section} key={group}>
            <h2 className={styles.sectionTitle}>{group}</h2>
            <div className={`${styles.panel} ${styles.categoryRows}`}>
              {labels
                .filter((item) => item.group === group)
                .map((item) => (
                  <label className={styles.preferenceRow} key={item.key}>
                    <span>{item.label}</span>
                    <input
                      type="checkbox"
                      checked={me.user.notificationPrefs[item.key]}
                      disabled={busy !== null}
                      onChange={() => void toggle(item.key)}
                    />
                  </label>
                ))}
            </div>
          </section>
        ))}
    </div>
  );
}
