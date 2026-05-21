"use client";

import { useCallback, useEffect, useState } from "react";
import type { Member } from "@fina/shared";
import { apiFetch, useMe, useActiveWorkspaceId } from "../../../../lib/api";
import { ConnectBankButton } from "./_components/connect-bank-button";
import { ConnectedBanksList, type PlaidItemView } from "./_components/connected-banks-list";

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
        apiFetch<{ plaidItems: PlaidItemView[] }>(`/workspaces/${wsId}/plaid-items`),
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

  // Errors first — if /me or /plaid-items or /members fails, `me`/`members`
  // stays null but `meErr`/`err` is set. A loading-first check would render
  // "Loading…" forever in that case.
  if (meErr) return <main style={{ padding: 32 }}>Could not load profile: {meErr}</main>;
  if (err) return <main style={{ padding: 32 }}>Could not load banks: {err}</main>;
  if (!wsId || me === null || members === null) return <main style={{ padding: 32 }}>Loading…</main>;

  const isPro = me.tier === "pro";
  // Owner-only for ALL Plaid mutations (link / refresh / disconnect).
  // Server enforces this too; the UI hides the affordances so non-owners
  // don't get rejected mid-action.
  const isOwner = members.find((m) => m.userId === me.user.id)?.role === "owner";

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 32, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Banks</h1>
      <p style={{ opacity: 0.6, marginBottom: 24 }}>
        Connect your bank account so Fina can import your transactions automatically.
      </p>
      <ConnectedBanksList items={items ?? []} workspaceId={wsId} isOwner={isOwner} onChange={load} />
      <div style={{ marginTop: 24 }}>
        <ConnectBankButton workspaceId={wsId} isPro={isPro} isOwner={isOwner} onConnected={load} />
      </div>
      {!isOwner && (
        <p style={{ opacity: 0.6, marginTop: 24, fontSize: 13 }}>
          Only the workspace owner can connect, refresh, or disconnect a bank.
        </p>
      )}
    </main>
  );
}
