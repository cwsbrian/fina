"use client";

import { useEffect, useState } from "react";
import type { WorkspaceSummary as Workspace } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../lib/api";
import {
  getActiveWorkspaceId,
  setActiveWorkspaceId,
} from "../../../lib/active-workspace";

export function WorkspaceSwitcher() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [, list] = await Promise.all([
          bootstrapActiveWorkspace(),
          apiFetch<{ workspaces: Workspace[] }>("/workspaces"),
        ]);
        setWorkspaces(list.workspaces);
        setActiveId(getActiveWorkspaceId() ?? list.workspaces[0]?.id ?? null);
      } catch {
        // ignore — header just won't render
      }
    })();
  }, []);

  if (workspaces.length < 2) {
    const single = workspaces[0];
    return (
      <div style={{ fontSize: 14 }}>
        {single ? (
          <>
            <span style={{ opacity: 0.6 }}>Workspace:</span>{" "}
            <strong>{single.name}</strong>{" "}
            <span style={{ opacity: 0.6 }}>({single.role})</span>
          </>
        ) : null}
      </div>
    );
  }

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    setActiveWorkspaceId(id);
    setActiveId(id);
    // Full reload re-fetches every page consumer with the new header.
    window.location.reload();
  }

  return (
    <select
      value={activeId ?? ""}
      onChange={onChange}
      style={{ padding: 6, border: "1px solid #ddd", borderRadius: 6 }}
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name} ({w.role})
        </option>
      ))}
    </select>
  );
}
