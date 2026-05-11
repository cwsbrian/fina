"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../../../lib/api";
import { setActiveWorkspaceId } from "../../../lib/active-workspace";

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
    <div>
      <button
        onClick={accept}
        disabled={busy}
        style={{
          padding: "12px 24px",
          background: "#111",
          color: "#fff",
          borderRadius: 8,
          border: "none",
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy ? "Joining..." : "Accept invite"}
      </button>
      {err && <p style={{ color: "#c00", marginTop: 12 }}>{err}</p>}
    </div>
  );
}
