"use client";

import { useCallback, useEffect, useState } from "react";
import { TIER_LIMITS, type Member, type PlaidItemDTO } from "@fina/shared";
import { apiFetch, useMe, useActiveWorkspaceId } from "../../../../lib/api";
import styles from "../settings.module.css";
import { ConnectBankButton } from "./_components/connect-bank-button";
import { ConnectedBanksList } from "./_components/connected-banks-list";

export default function BanksPage() {
  const wsId = useActiveWorkspaceId();
  const { me, err: meErr } = useMe();
  const [items, setItems] = useState<PlaidItemDTO[] | null>(null);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!wsId) return;
    setErr(null);
    try {
      const [itemsRes, membersRes] = await Promise.all([
        apiFetch<{ plaidItems: PlaidItemDTO[] }>(
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

  // Server enforces owner-only on every Plaid mutation; the UI just hides
  // the affordance so non-owners don't trigger 403s.
  const isOwner =
    members.find((m) => m.userId === me.user.id)?.role === "owner";
  const bankCount = items?.length ?? 0;
  const ownedBankCount = (items ?? []).filter(
    (item) => item.connectedByUserId === me.user.id,
  ).length;
  const plaidItemLimit = TIER_LIMITS[me.tier].plaidItems;
  const remainingBanks = Math.max(plaidItemLimit - ownedBankCount, 0);
  const hasPaidPlaidEntitlement = plaidItemLimit > 0;

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
                ? hasPaidPlaidEntitlement
                  ? remainingBanks > 0
                    ? `Your plan includes ${plaidItemLimit} connected bank${plaidItemLimit === 1 ? "" : "s"}. Plaid is read-only; Fina can't move money.`
                    : `Your plan includes ${plaidItemLimit} connected bank${plaidItemLimit === 1 ? "" : "s"}. Disconnect one before adding another.`
                  : "Choose a paid plan to connect a bank."
                : "Only the workspace owner can connect or manage banks."}
            </div>
          </div>
        </div>
        <div className={styles.card}>
          <ConnectBankButton
            workspaceId={wsId}
            tier={me.tier}
            plaidItemLimit={plaidItemLimit}
            bankCount={ownedBankCount}
            isOwner={isOwner}
            onConnected={load}
          />
        </div>
      </div>
    </div>
  );
}
