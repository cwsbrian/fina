"use client";
import { useEffect, useState } from "react";
import { signOut } from "../../../auth/client";
import { env } from "../../../env";

type Me = {
  user: { id: string; email: string; tz: string; locale: string };
  workspace: { id: string; name: string; role: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};

async function fetchMe(): Promise<Me> {
  const res = await fetch(`${env.NEXT_PUBLIC_API_URL}/me`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

export default function HomePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetchMe()
      .then(setMe)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main style={{ padding: 32, fontFamily: "system-ui", maxWidth: 600 }}>
      <h1 style={{ fontSize: 32, marginBottom: 24 }}>Welcome</h1>
      {err && <p style={{ color: "#c00" }}>Could not reach API: {err}</p>}
      {!me && !err && <p>Loading…</p>}
      {me && (
        <div
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 16,
            marginBottom: 24,
          }}
        >
          <div style={{ fontSize: 12, opacity: 0.5 }}>Workspace</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{me.workspace.name}</div>
          <div style={{ fontSize: 12, opacity: 0.5, marginTop: 8 }}>Role</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{me.workspace.role}</div>
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
