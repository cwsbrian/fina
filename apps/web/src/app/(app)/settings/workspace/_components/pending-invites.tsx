"use client";

import { useState } from "react";
import { apiFetch } from "../../../../../lib/api";

type Invite = {
  id: string;
  invitedEmail: string;
  invitedRole: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
};

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
      await apiFetch(`/workspaces/${workspaceId}/invites/${inviteId}`, { method: "DELETE" });
      onChange();
    } finally {
      setBusyId(null);
    }
  }

  if (invites.length === 0) {
    return <p style={{ opacity: 0.6, marginTop: 8 }}>No pending invites.</p>;
  }
  return (
    <ul style={{ listStyle: "none", padding: 0 }}>
      {invites.map((i) => (
        <li
          key={i.id}
          style={{
            padding: 8,
            borderBottom: "1px solid #f5f5f5",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <span>
            {i.invitedEmail} <span style={{ opacity: 0.6 }}>({i.invitedRole})</span>
          </span>
          <button
            onClick={() => revoke(i.id)}
            disabled={busyId === i.id}
            style={{
              padding: "4px 10px",
              background: "#fff",
              border: "1px solid #ddd",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Revoke
          </button>
        </li>
      ))}
    </ul>
  );
}
