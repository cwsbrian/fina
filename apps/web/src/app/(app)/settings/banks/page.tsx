"use client";

import { useCallback, useEffect, useState } from "react";
import type { Member } from "@fina/shared";
import { apiFetch, useMe, useActiveWorkspaceId } from "../../../../lib/api";
import styles from "../settings.module.css";
import { ConnectBankButton } from "./_components/connect-bank-button";
import {
  ConnectedBanksList,
  type PlaidItemView,
} from "./_components/connected-banks-list";

export default function BanksPage() {
  const wsId = useActiveWorkspaceId();
  const { me, err: meErr } = useMe();
  const [items, setItems] = useState<PlaidItemView[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    setErr(null);
    try {
      const [itemsRes, membersRes] = await Promise.all([
        apiFetch<{ plaidItems: PlaidItemView[] }>(
          `/workspaces/${wsId}/plaid-items`,
        ),
        apiFetch<{ members: Member[] }>(`/workspaces/${wsId}/members`),
      ]);
      setItems(itemsRes.plaidItems);
      setMembers(membersRes.members);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    }
  }, [wsId]);

  useEffect(() => {
    load();
  }, [load]);

  // Errors first — if a sub-request fails, members/items stays null but
  // err is set. A loading-first check would render "Loading…" forever.
  if (meErr) {
    return (
      <div className={styles.container}>
        <p style={{ color: "var(--color-down)" }}>
          Could not load profile: {meErr}
        </p>
      </div>
    );
  }
  if (err) {
    return (
      <div className={styles.container}>
        <p style={{ color: "var(--color-down)" }}>Could not load: {err}</p>
      </div>
    );
  }
  if (!wsId || me === null || members === null) {
    return <div className={styles.container}>Loading…</div>;
  }

  const isPro = me.tier === "pro";
  // Server enforces owner-only on every Plaid mutation; the UI just hides
  // the affordance so non-owners don't trigger 403s.
  const isOwner =
    members.find((m) => m.userId === me.user.id)?.role === "owner";
  const bankCount = items?.length ?? 0;

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <h1 className={styles.title}>Banks</h1>
        <p className={styles.sub}>
          Connect your bank so Fina can import your transactions automatically.
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Connected banks</div>
            <div className={styles.sectionSub}>
              {bankCount === 0
                ? "No banks connected yet."
                : `${bankCount} bank${bankCount === 1 ? "" : "s"} feeding Fina.`}
            </div>
          </div>
        </div>
        <ConnectedBanksList
          items={items ?? []}
          workspaceId={wsId}
          isOwner={isOwner}
          onChange={load}
        />
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Connect a bank</div>
            <div className={styles.sectionSub}>
              {isOwner
                ? isPro
                  ? "Plaid securely links your account. Read-only — Fina can't move money."
                  : "Connecting a bank requires Pro."
                : "Only the workspace owner can connect or manage banks."}
            </div>
          </div>
        </div>
        <div className={styles.card}>
          <ConnectBankButton
            workspaceId={wsId}
            isPro={isPro}
            isOwner={isOwner}
            onConnected={load}
          />
        </div>
      </div>
    </div>
  );
}
