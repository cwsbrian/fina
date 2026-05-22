"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  initials,
  tierLabel,
  trialDaysLeft,
  type MeDTO,
  type WorkspaceSummary,
} from "@fina/shared";
import { useSession, signOut } from "../auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../lib/api";
import {
  getActiveWorkspaceId,
  setActiveWorkspaceId,
} from "../lib/active-workspace";
import { syncDeviceTz } from "../lib/tz-sync";
import { WebIcon } from "./WebIcon";
import styles from "./shell.module.css";

export type ShellState = {
  me: MeDTO | null;
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  error: string | null;
};

const NAV_ITEMS = [
  { id: "home", label: "Home", path: "/home" },
  { id: "banks", label: "Banks", path: "/settings/banks" },
  { id: "workspace", label: "Workspace", path: "/settings/workspace" },
  { id: "plan", label: "Plan", path: "/settings/plan" },
  { id: "account", label: "Account", path: "/settings/account" },
];

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { data: session } = useSession();

  const [me, setMe] = useState<MeDTO | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        await bootstrapActiveWorkspace();
        const [meData, wsData] = await Promise.all([
          apiFetch<MeDTO>("/me"),
          apiFetch<{ workspaces: WorkspaceSummary[] }>("/workspaces"),
        ]);
        setMe(meData);
        setWorkspaces(wsData.workspaces);
        const stored = getActiveWorkspaceId();
        const valid =
          stored && wsData.workspaces.some((w) => w.id === stored)
            ? stored
            : (wsData.workspaces[0]?.id ?? null);
        setActiveWsId(valid);
      } catch (e) {
        setError((e as { code?: string }).code ?? "load_error");
      }
    })();
  }, []);

  // Device tz auto-sync — fires on mount + when tab becomes visible again.
  // Throttled internally (6h) and skipped if tz hasn't changed.
  useEffect(() => {
    syncDeviceTz();
    const onVis = () => {
      if (document.visibilityState === "visible") syncDeviceTz();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  function navigate(path: string) {
    router.push(path);
  }

  function isActive(path: string) {
    if (path === "/home") return pathname === "/home";
    return pathname.startsWith(path);
  }

  function onSignOut() {
    void signOut().then(() => router.replace("/sign-in"));
  }

  function switchWorkspace(id: string) {
    setActiveWorkspaceId(id);
    setActiveWsId(id);
    // Hard reload so every page consumer re-fetches with the new header.
    window.location.reload();
  }

  const activeWs = workspaces.find((w) => w.id === activeWsId) ?? null;
  const userInitials = me
    ? initials(me.user.name, me.user.email)
    : initials(undefined, session?.user?.email ?? "?");
  const trialDays = me ? trialDaysLeft(me.trial.endsAt) : null;
  const tierTag = me ? tierLabel(me.tier, me.trial.active) : "Free";

  return (
    <div className={styles.shell}>
      <nav className={styles.nav}>
        <div className={styles.navInner}>
          <button
            type="button"
            className={styles.brand}
            onClick={() => navigate("/home")}
            aria-label="Fina home"
          >
            <img src="/images/logo-dark.png" alt="Fina" className={styles.brandLogo} />
          </button>

          <div className={styles.links}>
            {NAV_ITEMS.map((it) => (
              <button
                key={it.id}
                type="button"
                className={`${styles.link} ${isActive(it.path) ? styles.linkActive : ""}`}
                onClick={() => navigate(it.path)}
              >
                {it.label}
              </button>
            ))}
          </div>

          <div className={styles.right}>
            {me && (
              <button
                type="button"
                className={`${styles.tierBadge} ${me.trial.active ? styles.tierBadgeTrial : me.tier === "pro" ? styles.tierBadgePro : ""}`}
                onClick={() => navigate("/settings/plan")}
                title={`${tierTag} plan`}
              >
                <span className={styles.tierDot} />
                {me.trial.active && trialDays !== null
                  ? `Trial · ${trialDays}d left`
                  : tierTag}
              </button>
            )}

            <WorkspaceMenu
              active={activeWs}
              workspaces={workspaces}
              onSwitch={switchWorkspace}
            />

            <UserMenu
              email={me?.user.email ?? session?.user?.email ?? ""}
              name={me?.user.name}
              initialsText={userInitials}
              onNavigate={navigate}
              onSignOut={onSignOut}
            />
          </div>
        </div>
      </nav>

      <main className={styles.page}>
        {error ? (
          <div style={{ padding: 24, color: "var(--color-down)" }}>
            Could not load: {error}
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}

function WorkspaceMenu({
  active,
  workspaces,
  onSwitch,
}: {
  active: WorkspaceSummary | null;
  workspaces: WorkspaceSummary[];
  onSwitch: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!active) return null;
  return (
    <div className={styles.wsWrap}>
      <button
        type="button"
        className={styles.wsBtn}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{active.name}</span>
        <span className={styles.wsBtnRole}>{active.role}</span>
        <WebIcon
          name="chevDown"
          size={14}
          color="var(--color-muted)"
          strokeWidth={2}
        />
      </button>
      {open && (
        <>
          <div className={styles.scrim} onClick={() => setOpen(false)} />
          <div className={styles.menu} style={{ minWidth: 280 }}>
            <div className={styles.menuHead}>
              <div className={styles.menuHeadName}>Workspaces</div>
              <div className={styles.menuHeadMail}>
                {workspaces.length}{" "}
                {workspaces.length === 1 ? "workspace" : "workspaces"}
              </div>
            </div>
            {workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`${styles.menuItem} ${w.id === active.id ? styles.menuItemActive : ""}`}
                onClick={() => {
                  setOpen(false);
                  if (w.id !== active.id) onSwitch(w.id);
                }}
              >
                <span style={{ flex: 1 }}>{w.name}</span>
                <span className={styles.wsBtnRole}>{w.role}</span>
                {w.id === active.id && (
                  <WebIcon
                    name="check"
                    size={14}
                    color="var(--color-primary)"
                    strokeWidth={2.4}
                  />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function UserMenu({
  email,
  name,
  initialsText,
  onNavigate,
  onSignOut,
}: {
  email: string;
  name?: string | null | undefined;
  initialsText: string;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.wsWrap}>
      <button
        type="button"
        className={styles.avatarBtn}
        onClick={() => setOpen((o) => !o)}
        title={name ?? email}
      >
        {initialsText}
      </button>
      {open && (
        <>
          <div className={styles.scrim} onClick={() => setOpen(false)} />
          <div className={styles.menu}>
            <div className={styles.menuHead}>
              <div className={styles.menuHeadName}>{name || email}</div>
              <div className={styles.menuHeadMail}>{email}</div>
            </div>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                onNavigate("/settings/account");
                setOpen(false);
              }}
            >
              <WebIcon name="user" size={16} color="var(--color-muted)" />
              Account settings
            </button>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                onNavigate("/settings/plan");
                setOpen(false);
              }}
            >
              <WebIcon name="card" size={16} color="var(--color-muted)" />
              Plan &amp; billing
            </button>
            <button
              type="button"
              className={styles.menuItem}
              onClick={() => setOpen(false)}
            >
              <WebIcon name="smartphone" size={16} color="var(--color-muted)" />
              Get the mobile app
            </button>
            <div className={styles.menuDivider} />
            <button
              type="button"
              className={`${styles.menuItem} ${styles.menuItemDanger}`}
              onClick={() => {
                onSignOut();
                setOpen(false);
              }}
            >
              <WebIcon name="logOut" size={16} />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}
