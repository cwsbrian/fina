"use client";

import { useCallback, useEffect, useState } from "react";
import type { Member, Invite } from "@fina/shared";
import { useSession } from "../../../../auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../../../lib/api";
import { getActiveWorkspaceId } from "../../../../lib/active-workspace";
import styles from "../settings.module.css";
import { MembersList } from "./_components/members-list";
import { InviteForm } from "./_components/invite-form";
import { PendingInvites } from "./_components/pending-invites";

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
        const { invites } = await apiFetch<{ invites: Invite[] }>(
          `/workspaces/${id}/invites`,
        );
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

  if (!session?.user) {
    return <div className={styles.container}>Loading…</div>;
  }
  if (err) {
    return (
      <div className={styles.container}>
        <p style={{ color: "var(--color-down)" }}>Could not load: {err}</p>
      </div>
    );
  }
  if (!wsId) return <div className={styles.container}>Loading workspace…</div>;

  const me = members.find((m) => m.userId === session.user.id);
  const isOwner = me?.role === "owner";
  const myRoleLabel = me?.role
    ? me.role.charAt(0).toUpperCase() + me.role.slice(1)
    : null;

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <h1 className={styles.title}>Workspace</h1>
        <p className={styles.sub}>
          {wsName}
          {myRoleLabel && (
            <> · Your role: <strong>{myRoleLabel}</strong></>
          )}
        </p>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Members</div>
            <div className={styles.sectionSub}>
              {members.length === 1
                ? "Just you for now."
                : `${members.length} people have access to ${wsName}.`}
            </div>
          </div>
        </div>
        <MembersList
          members={members}
          workspaceId={wsId}
          currentUserId={session.user.id}
          isOwner={isOwner}
          onChange={load}
        />
      </div>

      {isOwner && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <div>
              <div className={styles.sectionTitle}>Invite a member</div>
              <div className={styles.sectionSub}>
                They&apos;ll get an email with a link to join {wsName}.
              </div>
            </div>
          </div>
          <div className={styles.card}>
            <InviteForm workspaceId={wsId} onCreated={load} />
          </div>
        </div>
      )}

      {isOwner && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <div>
              <div className={styles.sectionTitle}>Pending invites</div>
              <div className={styles.sectionSub}>
                Invitations that haven&apos;t been accepted yet.
              </div>
            </div>
          </div>
          <PendingInvites invites={invites} workspaceId={wsId} onChange={load} />
        </div>
      )}
    </div>
  );
}
