"use client";

import { useState } from "react";
import type { Member } from "@fina/shared";
import { initials } from "@fina/shared";
import { apiFetch } from "../../../../../lib/api";
import styles from "../../settings.module.css";

const ROLES: Member["role"][] = ["owner", "editor", "viewer"];

function rolePillClass(role: Member["role"]): string {
  if (role === "owner") return `${styles.pill} ${styles.pillActive}`;
  if (role === "editor") return `${styles.pill} ${styles.pillWarn}`;
  return `${styles.pill} ${styles.pillNeutral}`;
}

function roleLabel(role: Member["role"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function MembersList({
  members,
  workspaceId,
  currentUserId,
  isOwner,
  onChange,
}: {
  members: Member[];
  workspaceId: string;
  currentUserId: string;
  isOwner: boolean;
  onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function patchRole(userId: string, role: Member["role"]) {
    // Transfer is a one-way demotion of the current user — confirm before firing.
    if (
      role === "owner" &&
      !window.confirm("Transfer ownership? You will become an editor.")
    ) {
      return;
    }
    setBusyId(userId);
    setErr(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      });
      onChange();
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(userId: string) {
    const isSelf = userId === currentUserId;
    const msg = isSelf ? "Leave this workspace?" : "Remove this member?";
    if (!window.confirm(msg)) return;
    setBusyId(userId);
    setErr(null);
    try {
      await apiFetch(`/workspaces/${workspaceId}/members/${userId}`, {
        method: "DELETE",
      });
      onChange();
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={styles.group}>
      {members.map((m) => {
        const isSelf = m.userId === currentUserId;
        const displayName = m.name?.trim() || m.email.split("@")[0];
        const canEditRole = isOwner && !isSelf;
        return (
          <div key={m.userId} className={styles.row}>
            <span className={styles.memberAvatar}>
              {initials(m.name, m.email)}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={styles.rowTitle}>
                {displayName}
                {isSelf && (
                  <span className={styles.tagCurrent}>You</span>
                )}
              </div>
              <div className={styles.rowMeta}>{m.email}</div>
            </div>
            {canEditRole ? (
              <select
                className={styles.select}
                style={{ width: 130 }}
                value={m.role}
                disabled={busyId === m.userId}
                onChange={(e) =>
                  patchRole(m.userId, e.target.value as Member["role"])
                }
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r === "owner" ? "Owner (transfer)" : roleLabel(r)}
                  </option>
                ))}
              </select>
            ) : (
              <span className={rolePillClass(m.role)}>
                <span className={styles.pillDot} />
                {roleLabel(m.role)}
              </span>
            )}
            {(isOwner || isSelf) && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnOutline} ${styles.btnSm}`}
                onClick={() => remove(m.userId)}
                disabled={busyId === m.userId}
              >
                {isSelf ? "Leave" : "Remove"}
              </button>
            )}
          </div>
        );
      })}
      {err && <div className={styles.feedbackErr}>Could not update: {err}</div>}
    </div>
  );
}
