"use client";

import { useState } from "react";
import { apiFetch } from "../../../../../lib/api";

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
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/invites`, {
        method: "POST",
        body: JSON.stringify({ email, role }),
      });
      setEmail("");
      setOk(`Invite sent to ${email}`);
      onCreated();
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, alignItems: "center" }}>
      <input
        type="email"
        required
        placeholder="email@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{ padding: 8, border: "1px solid #ddd", borderRadius: 6, flex: 1 }}
      />
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as "editor" | "viewer")}
        style={{ padding: 8, border: "1px solid #ddd", borderRadius: 6 }}
      >
        <option value="editor">editor</option>
        <option value="viewer">viewer</option>
      </select>
      <button
        type="submit"
        disabled={busy || !email}
        style={{
          padding: "8px 16px",
          background: "#111",
          color: "#fff",
          border: "none",
          borderRadius: 6,
          cursor: "pointer",
        }}
      >
        {busy ? "..." : "Invite"}
      </button>
      {err && <span style={{ color: "#c00", marginLeft: 8 }}>{err}</span>}
      {ok && <span style={{ color: "#0a7", marginLeft: 8 }}>{ok}</span>}
    </form>
  );
}
