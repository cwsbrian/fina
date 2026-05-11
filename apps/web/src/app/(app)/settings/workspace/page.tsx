"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "../../../../auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../../../lib/api";
import { getActiveWorkspaceId } from "../../../../lib/active-workspace";
import { MembersList } from "./_components/members-list";
import { InviteForm } from "./_components/invite-form";
import { PendingInvites } from "./_components/pending-invites";

type Member = {
  userId: string;
  email: string;
  name: string | null;
  role: "owner" | "editor" | "viewer";
};
type Invite = {
  id: string;
  invitedEmail: string;
  invitedRole: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
};

export default function WorkspaceSettingsPage() {
  const { data: session } = useSession();
  const [wsId, setWsId] = useState<string | null>(null);
  const [wsName, setWsName] = useState<string>("");
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const id = (await bootstrapActiveWorkspace()) ?? getActiveWorkspaceId();
      if (!id) {
        setErr("no_workspace");
        return;
      }
      setWsId(id);
      const [{ workspaces }, { members }] = await Promise.all([
        apiFetch<{ workspaces: { id: string; name: string }[] }>("/workspaces"),
        apiFetch<{ members: Member[] }>(`/workspaces/${id}/members`),
      ]);
      const current = workspaces.find((w) => w.id === id);
      setWsName(current?.name ?? "");
      setMembers(members);
      const myMembership = members.find((m) => m.userId === session?.user?.id);
      if (myMembership?.role === "owner") {
        const { invites } = await apiFetch<{ invites: Invite[] }>(`/workspaces/${id}/invites`);
        setInvites(invites);
      } else {
        setInvites([]);
      }
    } catch (e) {
      setErr((e as { code?: string }).code ?? "error");
    }
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user) return;
    load();
  }, [session?.user, load]);

  if (!session?.user) return <main style={{ padding: 32 }}>Loading…</main>;
  if (err) return <main style={{ padding: 32 }}>Error: {err}</main>;
  if (!wsId) return <main style={{ padding: 32 }}>Loading workspace…</main>;

  const me = members.find((m) => m.userId === session.user.id);
  const isOwner = me?.role === "owner";

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: 32, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Workspace settings</h1>
      <p style={{ opacity: 0.6, marginBottom: 24 }}>{wsName}</p>

      <MembersList
        members={members}
        workspaceId={wsId}
        currentUserId={session.user.id}
        isOwner={isOwner}
        onChange={load}
      />

      {isOwner && (
        <section style={{ marginTop: 32 }}>
          <h2 style={{ fontSize: 18, marginBottom: 12 }}>Invite a member</h2>
          <InviteForm workspaceId={wsId} onCreated={load} />
          <h3 style={{ fontSize: 16, marginTop: 24, marginBottom: 8 }}>Pending invites</h3>
          <PendingInvites invites={invites} workspaceId={wsId} onChange={load} />
        </section>
      )}
    </main>
  );
}
