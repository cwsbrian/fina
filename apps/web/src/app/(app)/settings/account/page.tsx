"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  initials,
  MIN_PASSWORD_LENGTH,
  meetsPasswordPolicy,
  type MeDTO as Me,
} from "@fina/shared";
import { authClient, signOut } from "../../../../auth/client";
import { apiFetch } from "../../../../lib/api";
import { WebIcon } from "../../../../components/WebIcon";
import styles from "../settings.module.css";

export default function AccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [tz, setTz] = useState("America/Toronto");
  const [locale, setLocale] = useState("en");

  const [savingProfile, setSavingProfile] = useState(false);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  const [changingPw, setChangingPw] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);

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
    setProfileErr(null);
  };

  const onSave = async () => {
    if (savingProfile) return;
    setProfileErr(null);
    setSavingProfile(true);
    try {
      // Better Auth only edits the name today (email change goes through a
      // separate verification flow we haven't wired). If/when email change
      // lands we'll branch on emailChanging.
      const trimmedName = name.trim();
      const res = await authClient.updateUser({ name: trimmedName });
      if (res.error) {
        throw new Error(res.error.message ?? "Could not save profile");
      }
      setMe({ ...me, user: { ...me.user, name: trimmedName } });
    } catch (e) {
      setProfileErr(e instanceof Error ? e.message : "Could not save profile");
    } finally {
      setSavingProfile(false);
    }
  };

  const onChangePassword = async () => {
    if (pwBusy) return;
    setPwErr(null);
    if (!meetsPasswordPolicy(newPw)) {
      setPwErr(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPw !== confirmPw) {
      setPwErr("New passwords don't match.");
      return;
    }
    setPwBusy(true);
    try {
      const res = await authClient.changePassword({
        currentPassword: currentPw,
        newPassword: newPw,
        revokeOtherSessions: true,
      });
      if (res.error) {
        throw new Error(res.error.message ?? "Could not update password");
      }
      setChangingPw(false);
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (e) {
      setPwErr(e instanceof Error ? e.message : "Could not update password");
    } finally {
      setPwBusy(false);
    }
  };

  const onSignOutEverywhere = async () => {
    if (!confirm("Sign out from all devices (including this one)?")) return;
    try {
      await authClient.revokeSessions();
    } catch {
      // Tolerate — the local signOut below still cleans up this device.
    }
    await signOut();
    router.replace("/sign-in");
  };

  const onDelete = async () => {
    if (
      !confirm(
        "Permanently delete your account and all data? This cannot be undone.",
      )
    )
      return;
    try {
      const res = await authClient.deleteUser({});
      if (res.error) {
        alert(res.error.message ?? "Could not delete account");
        return;
      }
      router.replace("/");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Could not delete account");
    }
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

          {profileErr && (
            <div
              className={styles.fieldHelper}
              style={{ color: "var(--color-down)", marginTop: 12 }}
            >
              {profileErr}
            </div>
          )}

          {dirty && (
            <div className={styles.formActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={onDiscard}
                disabled={savingProfile}
              >
                Discard
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={onSave}
                disabled={
                  savingProfile ||
                  // Email change is server-validated separately; for now we
                  // disable Save while email is dirty to avoid promising
                  // something the API doesn't do yet.
                  emailChanging
                }
              >
                {savingProfile ? "Saving…" : "Save changes"}
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
                value={currentPw}
                onChange={(e) => setCurrentPw(e.target.value)}
                autoFocus
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>New password</label>
              <input
                className={styles.input}
                type="password"
                autoComplete="new-password"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Confirm new password</label>
              <input
                className={styles.input}
                type="password"
                autoComplete="new-password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
              />
            </div>
            {pwErr && (
              <div
                className={styles.fieldHelper}
                style={{ color: "var(--color-down)" }}
              >
                {pwErr}
              </div>
            )}
            <div className={styles.formActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => {
                  setChangingPw(false);
                  setCurrentPw("");
                  setNewPw("");
                  setConfirmPw("");
                  setPwErr(null);
                }}
                disabled={pwBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={onChangePassword}
                disabled={pwBusy || !currentPw || !newPw || !confirmPw}
              >
                {pwBusy ? "Updating…" : "Update password"}
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
