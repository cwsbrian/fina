"use client";

import { useState } from "react";
import type { PlaidItemDTO } from "@fina/shared";
import { apiFetch } from "../../../../../lib/api";

/** Re-exported under the legacy name so existing callers keep working. */
export type PlaidItemView = PlaidItemDTO;

export function ConnectedBanksList({
  items,
  workspaceId,
  isOwner,
  onChange,
}: {
  items: PlaidItemView[];
  workspaceId: string;
  isOwner: boolean;
  onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function refresh(itemId: string) {
    setBusyId(itemId);
    setMsg(null);
    try {
      const r = await apiFetch<{ added?: number; modified?: number; removed?: number; skipped?: string }>(
        `/workspaces/${workspaceId}/plaid-items/${itemId}/sync`,
        { method: "POST" },
      );
      if (r.skipped === "lock_held") {
        // The per-page tx is the unit of durability, so anything the API
        // reports here was actually committed before we yielded to the
        // racing sync. Surface it instead of dropping the counters.
        const partial = (r.added ?? 0) + (r.modified ?? 0) + (r.removed ?? 0);
        setMsg(
          partial > 0
            ? `Another refresh is running. Got +${r.added ?? 0} / ~${r.modified ?? 0} / -${r.removed ?? 0} before yielding. Try again in a moment.`
            : "Another refresh is already running. Try again in a moment.",
        );
      } else {
        setMsg(`Refreshed: +${r.added ?? 0} added, ${r.modified ?? 0} modified, ${r.removed ?? 0} removed.`);
      }
      onChange();
    } catch (e) {
      setMsg(`Refresh failed: ${(e as { code?: string }).code ?? "error"}`);
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(itemId: string, name: string) {
    if (!window.confirm(`Disconnect "${name}"? Past transactions are kept.`)) return;
    setBusyId(itemId);
    setMsg(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/plaid-items/${itemId}`, { method: "DELETE" });
      setMsg("Disconnected.");
      onChange();
    } catch (e) {
      setMsg(`Disconnect failed: ${(e as { code?: string }).code ?? "error"}`);
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return <p style={{ opacity: 0.6 }}>No banks connected yet.</p>;
  }

  return (
    <div>
      {items.map((it) => (
        <div
          key={it.id}
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 16,
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 600 }}>{it.institutionName}</div>
          <div style={{ fontSize: 13, opacity: 0.6, marginTop: 4 }}>
            {it.accountCount} account{it.accountCount === 1 ? "" : "s"}
            {it.lastSyncAt ? ` · last sync ${new Date(it.lastSyncAt).toLocaleString()}` : " · never synced"}
          </div>
          {it.status === "relink_required" && (
            <div style={{ color: "#c00", marginTop: 8, fontSize: 13 }}>
              Reconnect needed (re-auth flow not implemented in this plan).
            </div>
          )}
          {it.status === "error" && (
            <div style={{ color: "#c00", marginTop: 8, fontSize: 13 }}>
              Sync error{it.errorCode ? ` (${it.errorCode})` : ""}.
            </div>
          )}
          {isOwner && (
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button
                onClick={() => refresh(it.id)}
                disabled={busyId === it.id}
                style={{
                  padding: "6px 12px",
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Refresh
              </button>
              <button
                onClick={() => disconnect(it.id, it.institutionName)}
                disabled={busyId === it.id}
                style={{
                  padding: "6px 12px",
                  background: "#fff",
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  cursor: "pointer",
                }}
              >
                Disconnect
              </button>
            </div>
          )}
        </div>
      ))}
      {msg && <p style={{ marginTop: 12, color: "#0a7" }}>{msg}</p>}
    </div>
  );
}
