"use client";

import { useState } from "react";
import { apiFetch } from "../../../../../lib/api";
import styles from "../../settings.module.css";

export function InviteForm({
  workspaceId,
  onCreated,
}: {
  workspaceId: string;
  onCreated: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"editor" | "viewer">("editor");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/invites`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
      setOk(`Invite sent to ${email}.`);
      setEmail("");
      onCreated();
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className={styles.inlineForm}>
        <div className={`${styles.field} ${styles.inlineFormEmail}`}>
          <label className={styles.fieldLabel}>Email</label>
          <input
            className={styles.input}
            type="email"
            required
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className={`${styles.field} ${styles.inlineFormRole}`}>
          <label className={styles.fieldLabel}>Role</label>
          <select
            className={styles.select}
            value={role}
            onChange={(e) => setRole(e.target.value as "editor" | "viewer")}
          >
            <option value="editor">Editor</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>
        <button
          type="submit"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={busy || !email}
        >
          {busy ? "Sending…" : "Send invite"}
        </button>
      </div>
      {err && <div className={styles.feedbackErr}>Could not invite: {err}</div>}
      {ok && <div className={styles.feedbackOk}>{ok}</div>}
    </form>
  );
}
