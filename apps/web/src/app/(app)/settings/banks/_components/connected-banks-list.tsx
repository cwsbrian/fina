"use client";

import { useState } from "react";
import type { PlaidItemDTO, PlaidItemStatus } from "@fina/shared";
import { apiFetch } from "../../../../../lib/api";
import { WebIcon } from "../../../../../components/WebIcon";
import styles from "../../settings.module.css";

function statusPill(status: PlaidItemStatus): {
  className: string;
  label: string;
} {
  switch (status) {
    case "active":
      return { className: `${styles.pill} ${styles.pillActive}`, label: "Active" };
    case "relink_required":
      return {
        className: `${styles.pill} ${styles.pillWarn}`,
        label: "Re-auth needed",
      };
    case "error":
      return {
        className: `${styles.pill} ${styles.pillWarn}`,
        label: "Sync error",
      };
    case "disconnected":
      return {
        className: `${styles.pill} ${styles.pillNeutral}`,
        label: "Disconnected",
      };
  }
}

function lastSyncLabel(d: string | Date | null): string {
  if (!d) return "Never synced";
  const t = typeof d === "string" ? new Date(d) : d;
  const diffMs = Date.now() - t.getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "Synced just now";
  if (mins < 60) return `Synced ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Synced ${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `Synced ${days}d ago`;
  return `Synced ${t.toLocaleDateString()}`;
}

export function ConnectedBanksList({
  items,
  workspaceId,
  isOwner,
  onChange,
}: {
  items: PlaidItemDTO[];
  workspaceId: string;
  isOwner: boolean;
  onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  async function refresh(itemId: string) {
    setBusyId(itemId);
    setMsg(null);
    try {
      const r = await apiFetch<{
        added?: number;
        modified?: number;
        removed?: number;
        skipped?: string;
      }>(`/workspaces/${workspaceId}/plaid-items/${itemId}/sync`, {
        method: "POST",
      });
      if (r.skipped === "lock_held") {
        // The per-page tx is the unit of durability, so anything the API
        // reports here was actually committed before we yielded to the
        // racing sync. Surface it instead of dropping the counters.
        const partial = (r.added ?? 0) + (r.modified ?? 0) + (r.removed ?? 0);
        setMsg({
          kind: "err",
          text:
            partial > 0
              ? `Another refresh is running. Got +${r.added ?? 0} / ~${r.modified ?? 0} / -${r.removed ?? 0} before yielding. Try again in a moment.`
              : "Another refresh is already running. Try again in a moment.",
        });
      } else {
        setMsg({
          kind: "ok",
          text: `Refreshed: +${r.added ?? 0} added, ${r.modified ?? 0} modified, ${r.removed ?? 0} removed.`,
        });
      }
      onChange();
    } catch (e) {
      setMsg({
        kind: "err",
        text: `Refresh failed: ${(e as { code?: string }).code ?? "error"}`,
      });
    } finally {
      setBusyId(null);
    }
  }

  async function disconnect(itemId: string, name: string) {
    if (!window.confirm(`Disconnect "${name}"? Past transactions are kept.`))
      return;
    setBusyId(itemId);
    setMsg(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/plaid-items/${itemId}`, {
        method: "DELETE",
      });
      setMsg({ kind: "ok", text: "Disconnected." });
      onChange();
    } catch (e) {
      setMsg({
        kind: "err",
        text: `Disconnect failed: ${(e as { code?: string }).code ?? "error"}`,
      });
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className={styles.card}>
        <div className={styles.rowMeta}>
          No banks connected yet. Use “Connect a bank” below.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className={styles.group}>
        {items.map((it) => {
          const inGrace = it.billingGraceEndsAt !== null;
          const pill = inGrace
            ? { className: `${styles.pill} ${styles.pillWarn}`, label: "Grace period" }
            : statusPill(it.status);
          return (
            <div key={it.id} className={styles.row} style={inGrace ? { opacity: 0.62 } : undefined}>
              <span className={styles.rowGlyph}>
                <WebIcon name="bank" size={20} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className={styles.rowTitle}>
                  {it.institutionName}
                  <span className={pill.className}>
                    <span className={styles.pillDot} />
                    {pill.label}
                  </span>
                </div>
                {it.connectedByName && (
                  <div className={styles.rowMeta}>
                    Connected by {it.connectedByName}
                  </div>
                )}
                <div className={styles.rowMeta}>
                  {it.accountCount} account{it.accountCount === 1 ? "" : "s"}
                  {" · "}
                  {lastSyncLabel(it.lastSyncAt)}
                  {it.status === "error" && it.errorCode
                    ? ` · ${it.errorCode}`
                    : ""}
                  {it.billingGraceEndsAt
                    ? ` · disconnects ${new Date(it.billingGraceEndsAt).toLocaleDateString()}`
                    : ""}
                </div>
              </div>
              {isOwner && (
                <>
                  {!inGrace && (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnOutline} ${styles.btnSm}`}
                      onClick={() => refresh(it.id)}
                      disabled={busyId === it.id}
                    >
                      {busyId === it.id ? "Refreshing…" : "Refresh"}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnOutline} ${styles.btnSm}`}
                    onClick={() => disconnect(it.id, it.institutionName)}
                    disabled={busyId === it.id}
                  >
                    Disconnect
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {msg && (
        <div
          className={msg.kind === "ok" ? styles.feedbackOk : styles.feedbackErr}
        >
          {msg.text}
        </div>
      )}
    </div>
  );
}
