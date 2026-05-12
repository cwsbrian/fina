"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import { apiFetch } from "../../../../../lib/api";

export function ConnectBankButton({
  workspaceId,
  isPro,
  isOwner,
  onConnected,
}: {
  workspaceId: string;
  isPro: boolean;
  isOwner: boolean;
  onConnected: () => void;
}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchToken = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await apiFetch<{ linkToken: string }>(
        `/workspaces/${workspaceId}/plaid/link-token`,
        { method: "POST" },
      );
      setLinkToken(r.linkToken);
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      setErr(code === "upgrade_required" ? "Pro tier required to connect a bank." : `Could not start: ${code}`);
    } finally {
      setBusy(false);
    }
  }, [workspaceId]);

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      try {
        await apiFetch(`/workspaces/${workspaceId}/plaid/exchange`, {
          method: "POST",
          body: JSON.stringify({
            publicToken,
            institutionId: metadata.institution?.institution_id ?? "unknown",
            institutionName: metadata.institution?.name ?? "Unknown bank",
          }),
        });
        onConnected();
        setLinkToken(null);
      } catch (e) {
        setErr(`Could not finalize: ${(e as { code?: string }).code ?? "error"}`);
      }
    },
    onExit: (e) => {
      if (e) setErr(`Exit: ${e.error_code ?? "unknown"}`);
      setLinkToken(null);
    },
  });

  // Open the Plaid Link modal in an effect, NOT during render. Calling
  // `open()` from the render body triggers React's render-during-render
  // warning and double-invokes under StrictMode.
  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  if (!isOwner) {
    return null; // Server enforces owner-only too; this just hides the affordance.
  }

  if (!isPro) {
    return (
      <div style={{ padding: "12px 0" }}>
        <span
          style={{
            display: "inline-block",
            padding: "12px 24px",
            background: "#eee",
            color: "#666",
            borderRadius: 8,
          }}
        >
          Plaid is a Pro feature — upgrade to connect a bank
        </span>
      </div>
    );
  }

  return (
    <div style={{ padding: "12px 0" }}>
      <button
        onClick={fetchToken}
        disabled={busy}
        style={{
          padding: "12px 24px",
          background: "#111",
          color: "#fff",
          borderRadius: 8,
          border: "none",
          cursor: busy ? "default" : "pointer",
        }}
      >
        {busy ? "..." : "Connect a bank"}
      </button>
      {err && <p style={{ color: "#c00", marginTop: 8 }}>{err}</p>}
    </div>
  );
}
