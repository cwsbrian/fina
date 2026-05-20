"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../../lib/api";
import { setActiveWorkspaceId } from "../../../lib/active-workspace";
import { WebIcon } from "../../../components/WebIcon";
import styles from "../../../components/auth.module.css";

export function AcceptButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function accept() {
    setBusy(true);
    setErr(null);
    try {
      const result = await apiFetch<{ workspaceId: string; role: string }>(
        `/invites/by-token/${encodeURIComponent(token)}/accept`,
        { method: "POST" },
      );
      setActiveWorkspaceId(result.workspaceId);
      router.replace("/home");
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      setErr(`Could not accept: ${code}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={accept}
        disabled={busy}
        className={styles.btn}
      >
        {busy ? "Joining…" : "Accept invite"}
        {!busy && <WebIcon name="check" size={16} strokeWidth={2.2} />}
      </button>
      {err && (
        <div
          className={`${styles.fieldHelper} ${styles.fieldHelperError}`}
          style={{ marginTop: 14, textAlign: "center" }}
        >
          {err}
        </div>
      )}
    </>
  );
}
