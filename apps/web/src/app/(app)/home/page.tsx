"use client";
import { useEffect, useState } from "react";
import { signOut } from "../../../auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../../lib/api";
import { getActiveWorkspaceId } from "../../../lib/active-workspace";

type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};
type Workspace = { id: string; name: string; role: string };

export default function HomePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await bootstrapActiveWorkspace();
        const [meData, wsData] = await Promise.all([
          apiFetch<Me>("/me"),
          apiFetch<{ workspaces: Workspace[] }>("/workspaces"),
        ]);
        setMe(meData);
        const activeId = getActiveWorkspaceId();
        setWorkspace(
          wsData.workspaces.find((w) => w.id === activeId) ?? wsData.workspaces[0] ?? null,
        );
      } catch (e) {
        setErr((e as { code?: string }).code ?? "error");
      }
    })();
  }, []);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 600 }}>
      <h1 style={{ fontSize: 32, marginBottom: 24 }}>Welcome</h1>
      {err && <p style={{ color: "#c00" }}>Could not reach API: {err}</p>}
      {!me && !err && <p>Loading…</p>}
      {me && workspace && (
        <div
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 16,
            marginBottom: 24,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.5 }}>Workspace</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{workspace.name}</div>
          <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>Role</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{workspace.role}</div>
          <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>Tier</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{me.tier.toUpperCase()}</div>
          {me.trial.active && (
            <div style={{ fontSize: 12, marginTop: 12, color: "#0a7" }}>
              Pro trial active — ends {new Date(me.trial.endsAt!).toLocaleDateString()}
            </div>
          )}
        </div>
      )}
      <button
        onClick={() => signOut()}
        style={{
          padding: "12px 24px",
          borderRadius: 8,
          border: "1px solid #ddd",
          background: "#fff",
          cursor: "pointer",
        }}
      >
        Sign out
      </button>
    </main>
  );
}
