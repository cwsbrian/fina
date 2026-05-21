"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MeDTO as Me } from "@fina/shared";
import { signOut } from "../../../../auth/client";
import { apiFetch } from "../../../../lib/api";
import { WebIcon } from "../../../../components/WebIcon";
import styles from "../settings.module.css";

function initials(name: string | null | undefined, email: string): string {
  const src = name?.trim() || email;
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export default function AccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tz, setTz] = useState("America/Toronto");
  const [locale, setLocale] = useState("en");
  const [changingPw, setChangingPw] = useState(false);

  useEffect(() => {
    apiFetch<Me>("/me")
      .then((data) => {
        setMe(data);
        setName(data.user.name ?? "");
        setEmail(data.user.email);
        setTz(data.user.tz);
        setLocale(data.user.locale);
      })
      .catch((e) => setErr((e as { code?: string }).code ?? "load_error"));
  }, []);

  if (err) {
    return (
      <div className={styles.container}>
        <p style={{ color: "var(--color-down)" }}>Could not load: {err}</p>
      </div>
    );
  }
  if (!me) return <div className={styles.container} />;

  const dirty = name !== (me.user.name ?? "") || email !== me.user.email;
  const emailChanging = email !== me.user.email;

  const onDiscard = () => {
    setName(me.user.name ?? "");
    setEmail(me.user.email);
  };

  const onSave = () => {
    // TODO: wire to /users/me PATCH endpoint when available
    alert("Profile save isn't wired to backend yet.");
  };

  const onSignOutEverywhere = async () => {
    if (!confirm("Sign out from all devices?")) return;
    // TODO: wire to /api/auth/sessions DELETE or similar. For now sign out
    // current session only.
    await signOut();
    router.replace("/sign-in");
  };

  const onDelete = () => {
    if (
      !confirm(
        "Permanently delete your account and all data? This cannot be undone.",
      )
    )
      return;
    alert("Account deletion isn't wired yet.");
  };

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <h1 className={styles.title}>Account</h1>
        <p className={styles.sub}>
          Your personal profile, password, and sessions. Settings here apply
          across all your workspaces.
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitle}>Profile</div>
        </div>
        <div className={styles.card}>
          <div className={styles.profileRow}>
            <div className={styles.profileAvatar}>
              {initials(me.user.name, me.user.email)}
            </div>
            <div style={{ flex: 1 }}>
              <div
                style={{
                  fontSize: 18,
                  fontWeight: 600,
                  color: "var(--color-ink)",
                }}
              >
                {me.user.name || me.user.email.split("@")[0]}
              </div>
              <div
                style={{
                  fontSize: 14,
                  color: "var(--color-body)",
                  marginTop: 4,
                }}
              >
                {me.user.email}
              </div>
            </div>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnOutline} ${styles.btnSm}`}
              disabled
            >
              Upload photo
            </button>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name</label>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
            />
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>Email</label>
            <input
              className={styles.input}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            {emailChanging && (
              <div className={styles.fieldHelper}>
                Changing your email requires re-verification via a link sent
                to the new address.
              </div>
            )}
          </div>

          <div className={styles.fieldRowFlex}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Timezone</label>
              <select
                className={styles.select}
                value={tz}
                onChange={(e) => setTz(e.target.value)}
              >
                <option value="America/Toronto">Toronto (UTC−5)</option>
                <option value="America/Vancouver">Vancouver (UTC−8)</option>
                <option value="America/Edmonton">Edmonton (UTC−7)</option>
                <option value="America/Halifax">Halifax (UTC−4)</option>
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Language</label>
              <select
                className={styles.select}
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
              >
                <option value="en">English</option>
                <option value="ko" disabled>
                  한국어 (coming soon)
                </option>
              </select>
            </div>
          </div>

          {dirty && (
            <div className={styles.formActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={onDiscard}
              >
                Discard
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={onSave}
              >
                Save changes
              </button>
            </div>
          )}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div className={styles.sectionTitle}>Password</div>
        </div>
        {!changingPw ? (
          <div className={styles.card}>
            <div className={styles.cardRow}>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: "var(--color-ink)",
                  }}
                >
                  Change password
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--color-muted)",
                    marginTop: 4,
                  }}
                >
                  Use Forgot password if you don&apos;t remember the current
                  one.
                </div>
              </div>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnOutline}`}
                onClick={() => setChangingPw(true)}
              >
                Change password
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.card}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Current password</label>
              <input
                className={styles.input}
                type="password"
                autoComplete="current-password"
                autoFocus
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>New password</label>
              <input
                className={styles.input}
                type="password"
                autoComplete="new-password"
                placeholder="At least 8 characters"
              />
            </div>
            <div className={styles.field} style={{ marginBottom: 0 }}>
              <label className={styles.fieldLabel}>Confirm new password</label>
              <input
                className={styles.input}
                type="password"
                autoComplete="new-password"
              />
            </div>
            <div className={styles.formActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => setChangingPw(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => {
                  alert("Password change isn't wired yet.");
                  setChangingPw(false);
                }}
              >
                Update password
              </button>
            </div>
          </div>
        )}
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Active sessions</div>
            <div className={styles.sectionSub}>
              Devices currently signed in to your Fina account.
            </div>
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnOutline} ${styles.btnSm}`}
            onClick={onSignOutEverywhere}
          >
            <WebIcon name="logOut" size={14} />
            Sign out everywhere
          </button>
        </div>
        <div className={styles.group}>
          <div className={styles.row}>
            <span className={styles.rowGlyph}>
              <WebIcon name="laptop" size={20} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={styles.rowTitle}>
                This browser
                <span className={styles.tagCurrent}>This device</span>
              </div>
              <div className={styles.rowMeta}>
                Signed in right now
              </div>
            </div>
          </div>
          {/* TODO: list other active sessions when /api/auth/sessions is wired */}
        </div>
      </div>

      <div className={styles.dangerZone}>
        <div className={styles.dangerZoneTitle}>Danger zone</div>
        <div className={styles.dangerCard}>
          <div className={styles.dangerCardBody}>
            <div className={styles.dangerCardTitle}>Delete account</div>
            <div className={styles.dangerCardSub}>
              Permanently delete your Fina account, all workspaces you own,
              and all your transactions. There&apos;s no undo.
            </div>
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnDanger}`}
            onClick={onDelete}
          >
            Delete account
          </button>
        </div>
      </div>
    </div>
  );
}
