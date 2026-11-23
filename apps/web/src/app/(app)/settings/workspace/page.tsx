"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CreateWorkspaceBody,
  PatchWorkspaceCurrencyBody,
  type Member,
  type Invite,
} from "@fina/shared";
import { useSession } from "../../../../auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../../../lib/api";
import { getActiveWorkspaceId, setActiveWorkspaceId } from "../../../../lib/active-workspace";
import styles from "../settings.module.css";
import { MembersList } from "./_components/members-list";
import { InviteForm } from "./_components/invite-form";
import { PendingInvites } from "./_components/pending-invites";

export default function WorkspaceSettingsPage() {
  const { data: session } = useSession();
  const [wsId, setWsId] = useState<string | null>(null);
  const [wsName, setWsName] = useState<string>("");
  const [wsCurrency, setWsCurrency] = useState("CAD");
  const [newName, setNewName] = useState("");
  const [newCurrency, setNewCurrency] = useState("CAD");
  const [busyWorkspace, setBusyWorkspace] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);

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
        apiFetch<{ workspaces: { id: string; name: string; currency: string }[] }>("/workspaces"),
        apiFetch<{ members: Member[] }>(`/workspaces/${id}/members`),
      ]);
      const current = workspaces.find((w) => w.id === id);
      setWsName(current?.name ?? "");
      setWsCurrency(current?.currency ?? "CAD");
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

  if (!session?.user) {
    return <div className={styles.container}>Loading…</div>;
  }
  if (err && err !== "no_workspace") {
    return (
      <div className={styles.container}>
        <p className={styles.loadError} role="alert">
          Could not load: {err}
        </p>
      </div>
    );
  }
  if (!wsId && err !== "no_workspace")
    return <div className={styles.container}>Loading workspace…</div>;
  if (!wsId)
    return (
      <div className={styles.container}>
        <div className={styles.head}>
          <h1 className={styles.title}>Create workspace</h1>
          <p className={styles.sub}>Start a workspace to use Fina.</p>
        </div>
        {actionErr && (
          <p role="alert" className={styles.loadError}>
            {actionErr}
          </p>
        )}
        <form
          className={`${styles.card} ${styles.inlineForm}`}
          onSubmit={createWorkspace}
        >
          <div className={`${styles.field} ${styles.inlineFormEmail}`}>
            <label className={styles.fieldLabel} htmlFor="workspace-new-name">
              Workspace name
            </label>
            <input
              className={styles.input}
              id="workspace-new-name"
              aria-label="New workspace name"
              placeholder="Workspace name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              required
              maxLength={80}
            />
          </div>
          <div className={`${styles.field} ${styles.inlineFormCode}`}>
            <label className={styles.fieldLabel} htmlFor="workspace-new-currency">
              Currency
            </label>
            <input
              className={styles.input}
              id="workspace-new-currency"
              aria-label="New workspace currency"
              placeholder="CAD"
              value={newCurrency}
              onChange={(event) => setNewCurrency(event.target.value.toUpperCase())}
              required
              maxLength={3}
            />
          </div>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            type="submit"
            disabled={busyWorkspace}
          >
            Create
          </button>
        </form>
      </div>
    );

  const me = members.find((m) => m.userId === session.user.id);
  const isOwner = me?.role === "owner";
  const myRoleLabel = me?.role ? me.role.charAt(0).toUpperCase() + me.role.slice(1) : null;

  async function createWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = CreateWorkspaceBody.safeParse({ name: newName, currency: newCurrency });
    if (!parsed.success || busyWorkspace) {
      setActionErr("Check the workspace name and currency.");
      return;
    }
    setBusyWorkspace(true);
    setActionErr(null);
    try {
      const result = await apiFetch<{ workspace: { id: string } }>("/workspaces", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setActiveWorkspaceId(result.workspace.id);
      window.location.href = "/settings/workspace";
    } catch (cause) {
      setActionErr((cause as { code?: string }).code ?? "Could not create workspace.");
    } finally {
      setBusyWorkspace(false);
    }
  }

  async function changeCurrency(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!wsId || busyWorkspace) return;
    const parsed = PatchWorkspaceCurrencyBody.safeParse({ currency: wsCurrency });
    if (!parsed.success) {
      setActionErr("Enter a three-letter currency code.");
      return;
    }
    if (
      !window.confirm(
        "Change the currency label for this workspace? Existing amounts will not be converted.",
      )
    )
      return;
    setBusyWorkspace(true);
    setActionErr(null);
    try {
      await apiFetch(`/workspaces/${wsId}/currency`, {
        method: "PATCH",
        body: JSON.stringify(parsed.data),
      });
      await load();
    } catch (cause) {
      setActionErr((cause as { code?: string }).code ?? "Could not change currency.");
    } finally {
      setBusyWorkspace(false);
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <h1 className={styles.title}>Workspace</h1>
        <p className={styles.sub}>
          {wsName}
          {myRoleLabel && (
            <>
              {" "}
              · Your role: <strong>{myRoleLabel}</strong>
            </>
          )}
        </p>
      </div>
      {actionErr && (
        <p role="alert" className={styles.loadError}>
          {actionErr}
        </p>
      )}

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Create workspace</div>
            <div className={styles.sectionSub}>Keep another household or project separate.</div>
          </div>
        </div>
        <form
          className={`${styles.card} ${styles.inlineForm}`}
          onSubmit={createWorkspace}
        >
          <div className={`${styles.field} ${styles.inlineFormEmail}`}>
            <label className={styles.fieldLabel} htmlFor="workspace-new-name">
              Workspace name
            </label>
            <input
              className={styles.input}
              id="workspace-new-name"
              aria-label="New workspace name"
              placeholder="Workspace name"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              required
              maxLength={80}
            />
          </div>
          <div className={`${styles.field} ${styles.inlineFormCode}`}>
            <label className={styles.fieldLabel} htmlFor="workspace-new-currency">
              Currency
            </label>
            <input
              className={styles.input}
              id="workspace-new-currency"
              aria-label="New workspace currency"
              placeholder="CAD"
              value={newCurrency}
              onChange={(event) => setNewCurrency(event.target.value.toUpperCase())}
              required
              maxLength={3}
            />
          </div>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            type="submit"
            disabled={busyWorkspace}
          >
            Create
          </button>
        </form>
      </div>

      {isOwner && (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <div>
              <div className={styles.sectionTitle}>Workspace currency</div>
              <div className={styles.sectionSub}>
                Amounts keep their numbers when you change the currency label.
              </div>
            </div>
          </div>
          <form
            className={`${styles.card} ${styles.inlineForm}`}
            onSubmit={changeCurrency}
          >
            <div className={`${styles.field} ${styles.inlineFormCode}`}>
              <label className={styles.fieldLabel} htmlFor="workspace-currency">
                Currency
              </label>
              <input
                className={styles.input}
                id="workspace-currency"
                aria-label="Workspace currency"
                value={wsCurrency}
                onChange={(event) => setWsCurrency(event.target.value.toUpperCase())}
                required
                maxLength={3}
              />
            </div>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              type="submit"
              disabled={busyWorkspace}
            >
              Save currency
            </button>
          </form>
        </div>
      )}

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
