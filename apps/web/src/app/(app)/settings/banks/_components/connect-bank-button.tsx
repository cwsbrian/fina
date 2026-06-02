"use client";

import { useCallback, useEffect, useState } from "react";
import type { Tier } from "@fina/shared";
import { usePlaidLink } from "react-plaid-link";
import { apiFetch } from "../../../../../lib/api";
import styles from "../../settings.module.css";

export function ConnectBankButton({
  workspaceId,
  tier,
  plaidItemLimit,
  bankCount,
  isOwner,
  onConnected,
}: {
  workspaceId: string;
  tier: Tier;
  plaidItemLimit: number;
  bankCount: number;
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
      setErr(
        code === "upgrade_required"
          ? "A paid plan is required to connect a bank."
          : code === "plaid_item_limit_reached"
            ? "Your plan's bank connection limit has been reached."
            : `Could not start: ${code}`,
      );
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
        setErr(
          `Could not finalize: ${(e as { code?: string }).code ?? "error"}`,
        );
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
    return (
      <div className={styles.rowMeta}>
        Only the workspace owner can connect or manage banks.
      </div>
    );
  }

  if (plaidItemLimit <= 0) {
    return (
      <div>
        <div className={styles.rowMeta} style={{ marginBottom: 12 }}>
          Choose a paid plan to connect a bank.
        </div>
        <a
          href="/settings/plan"
          className={`${styles.btn} ${styles.btnPrimary}`}
          style={{ textDecoration: "none", display: "inline-flex" }}
        >
          Upgrade to Lite
        </a>
      </div>
    );
  }

  if (bankCount >= plaidItemLimit) {
    return (
      <div>
        <div className={styles.rowMeta} style={{ marginBottom: 12 }}>
          Your plan includes {plaidItemLimit} connected bank{plaidItemLimit === 1 ? "" : "s"}.
        </div>
        {tier === "lite" ? (
          <a
            href="/settings/plan"
            className={`${styles.btn} ${styles.btnPrimary}`}
            style={{ textDecoration: "none", display: "inline-flex" }}
          >
            Upgrade to Pro
          </a>
        ) : (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled
          >
            Bank limit reached
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        className={`${styles.btn} ${styles.btnPrimary}`}
        onClick={fetchToken}
        disabled={busy}
      >
        {busy ? "Starting…" : "Connect a bank"}
      </button>
      {err && <div className={styles.feedbackErr}>{err}</div>}
    </div>
  );
}
