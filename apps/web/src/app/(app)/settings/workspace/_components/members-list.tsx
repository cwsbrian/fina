"use client";

import { useState } from "react";
import type { Member } from "@fina/shared";
import { apiFetch } from "../../../../../lib/api";

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
    if (role === "owner" && !window.confirm("Transfer ownership? You will become an editor.")) {
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
      await apiFetch(`/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" });
      onChange();
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2 style={{ fontSize: 18, marginBottom: 12 }}>Members</h2>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
            <th style={{ padding: 8 }}>Email</th>
            <th style={{ padding: 8 }}>Role</th>
            <th style={{ padding: 8 }}></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const isSelf = m.userId === currentUserId;
            return (
              <tr key={m.userId} style={{ borderBottom: "1px solid #f5f5f5" }}>
                <td style={{ padding: 8 }}>
                  {m.email}
                  {isSelf && <span style={{ opacity: 0.5 }}> (you)</span>}
                </td>
                <td style={{ padding: 8 }}>
                  {isOwner && !isSelf ? (
                    <select
                      value={m.role}
                      disabled={busyId === m.userId}
                      onChange={(e) => patchRole(m.userId, e.target.value as Member["role"])}
                    >
                      <option value="owner">owner (transfer)</option>
                      <option value="editor">editor</option>
                      <option value="viewer">viewer</option>
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td style={{ padding: 8, textAlign: "right" }}>
                  {(isOwner || isSelf) && (
                    <button
                      onClick={() => remove(m.userId)}
                      disabled={busyId === m.userId}
                      style={{
                        padding: "6px 12px",
                        background: "#fff",
                        border: "1px solid #ddd",
                        borderRadius: 6,
                        cursor: "pointer",
                      }}
                    >
                      {isSelf ? "Leave" : "Remove"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {err && <p style={{ color: "#c00", marginTop: 8 }}>Error: {err}</p>}
    </div>
  );
}
