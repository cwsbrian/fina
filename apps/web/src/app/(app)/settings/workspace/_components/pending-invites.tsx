"use client";

import { useState } from "react";
import type { Invite } from "@fina/shared";
import { apiFetch } from "../../../../../lib/api";
import styles from "../../settings.module.css";

function roleLabel(role: Invite["invitedRole"]): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

export function PendingInvites({
  invites,
  workspaceId,
  onChange,
}: {
  invites: Invite[];
  workspaceId: string;
  onChange: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  async function revoke(inviteId: string) {
    if (!window.confirm("Revoke this invite?")) return;
    setBusyId(inviteId);
    try {
      await apiFetch(`/workspaces/${workspaceId}/invites/${inviteId}`, {
        method: "DELETE",
      });
      onChange();
    } finally {
      setBusyId(null);
    }
  }

  if (invites.length === 0) {
    return (
      <div className={styles.group}>
        <div className={styles.row}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={styles.rowMeta}>No pending invites.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.group}>
      {invites.map((i) => (
        <div key={i.id} className={styles.row}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className={styles.rowTitle}>
              {i.invitedEmail}
              <span className={`${styles.pill} ${styles.pillNeutral}`}>
                <span className={styles.pillDot} />
                {roleLabel(i.invitedRole)}
              </span>
            </div>
            <div className={styles.rowMeta}>Awaiting acceptance</div>
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnOutline} ${styles.btnSm}`}
            onClick={() => revoke(i.id)}
            disabled={busyId === i.id}
          >
            {busyId === i.id ? "Revoking…" : "Revoke"}
          </button>
        </div>
      ))}
    </div>
  );
}
