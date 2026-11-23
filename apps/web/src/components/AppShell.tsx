"use client";

import { ReactNode, useEffect, useRef, useState } from "react";
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
import { WebIcon, type IconName } from "./WebIcon";
import { NAV_ITEMS } from "./shell-nav";
import { FinaChat } from "./FinaChat";
import styles from "./shell.module.css";

const PRIMARY_IDS = ["home", "activity", "analysis", "budget", "goals"];

/** How the sidebar groups NAV_ITEMS. Presentation only: the items, their
 *  order inside a group, and their paths all come from shell-nav. */
const NAV_GROUPS: Array<{ label: string | null; ids: string[] }> = [
  { label: null, ids: PRIMARY_IDS },
  { label: "Planning", ids: ["review", "scheduled", "subscriptions", "categories", "accounts"] },
  {
    label: "Settings",
    ids: ["banks", "workspace", "brief", "notifications", "categorization", "plan", "account", "support"],
  },
];

const NAV_ICONS: Record<string, IconName> = {
  home: "home",
  activity: "list",
  analysis: "chart",
  budget: "wallet",
  goals: "target",
  review: "inbox",
  categories: "tag",
  scheduled: "calendar",
  subscriptions: "repeat",
  accounts: "layers",
  banks: "bank",
  workspace: "users",
  brief: "sunrise",
  notifications: "bell",
  categorization: "sliders",
  plan: "card",
  account: "user",
  support: "help",
};

export type ShellState = {
  me: MeDTO | null;
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  error: string | null;
};

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const routePath = usePathname() ?? "";
  // Marking the current nav item from the path directly gave a hydration
  // mismatch in dev (server markup had no active item), and the highlight
  // then never appeared on first load. Apply the path after mount instead.
  const [pathname, setPathname] = useState("");
  useEffect(() => setPathname(routePath), [routePath]);
  const { data: session } = useSession();

  const [me, setMe] = useState<MeDTO | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWsId, setActiveWsId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMounted, setChatMounted] = useState(false);
  const chatLauncherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("chat") === "open") {
      setChatMounted(true);
      setChatOpen(true);
    }
  }, [routePath]);

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

  function closeChat() {
    setChatOpen(false);
    const url = new URL(window.location.href);
    if (url.searchParams.get("chat") === "open") {
      url.searchParams.delete("chat");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
    chatLauncherRef.current?.focus();
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
  const tierBadge = me && (
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
  );
  const userEmail = me?.user.email ?? session?.user?.email ?? "";

  return (
    <div className={styles.shell}>
      <nav className={styles.sidebar} aria-label="Main">
        <div className={styles.sideTop}>
          <button
            type="button"
            className={styles.brand}
            onClick={() => navigate("/home")}
            aria-label="Fina home"
          >
            <img src="/branding/fina-wordmark-white.png" alt="Fina" className={styles.brandLogo} />
          </button>
          {tierBadge}
        </div>

        <WorkspaceMenu
          active={activeWs}
          workspaces={workspaces}
          onSwitch={switchWorkspace}
        />

        <div className={styles.sideScroll}>
          {NAV_GROUPS.map((group) => (
            <div className={styles.sideGroup} key={group.label ?? "main"}>
              {group.label && <div className={styles.sideGroupLabel}>{group.label}</div>}
              {NAV_ITEMS.filter((it) => group.ids.includes(it.id)).map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={`${styles.sideLink} ${isActive(it.path) ? styles.sideLinkActive : ""}`}
                  aria-current={isActive(it.path) ? "page" : undefined}
                  onClick={() => navigate(it.path)}
                >
                  <WebIcon name={NAV_ICONS[it.id] ?? "chevRight"} size={17} strokeWidth={1.7} />
                  {it.label}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className={styles.sideFoot}>
          <UserMenu
            email={userEmail}
            name={me?.user.name}
            initialsText={userInitials}
            onNavigate={navigate}
            onSignOut={onSignOut}
            showIdentity
          />
        </div>
      </nav>

      <nav className={styles.nav} aria-label="Main">
        <div className={styles.navInner}>
          <button
            type="button"
            className={styles.brand}
            onClick={() => navigate("/home")}
            aria-label="Fina home"
          >
            <img src="/branding/fina-wordmark-white.png" alt="Fina" className={styles.brandLogo} />
          </button>

          <div className={styles.right}>
            {tierBadge}

            <WorkspaceMenu
              active={activeWs}
              workspaces={workspaces}
              onSwitch={switchWorkspace}
            />

            <UserMenu
              email={userEmail}
              name={me?.user.name}
              initialsText={userInitials}
              onNavigate={navigate}
              onSignOut={onSignOut}
            />
          </div>
        </div>

        <div className={styles.tabs}>
          <div className={styles.links}>
            {NAV_ITEMS.filter((it) => PRIMARY_IDS.includes(it.id)).map((it) => (
              <button
                key={it.id}
                type="button"
                className={`${styles.link} ${isActive(it.path) ? styles.linkActive : ""}`}
                aria-current={isActive(it.path) ? "page" : undefined}
                onClick={() => navigate(it.path)}
              >
                {it.label}
              </button>
            ))}
          </div>
          <div className={styles.moreWrap}>
            <button
              type="button"
              className={`${styles.link} ${styles.moreBtn} ${NAV_ITEMS.some((it) => !PRIMARY_IDS.includes(it.id) && isActive(it.path)) ? styles.linkActive : ""}`}
              onClick={() => setMoreOpen((value) => !value)}
              aria-expanded={moreOpen}
              aria-haspopup="menu"
            >
              <span className={styles.moreLabel}>More</span>
              <span className={styles.moreChevron}>
                <WebIcon name="chevDown" size={14} strokeWidth={2} />
              </span>
              <span className={styles.moreGlyph}>
                <WebIcon name="menu" size={20} strokeWidth={1.8} />
              </span>
            </button>
            {moreOpen && (
              <>
                <div className={styles.scrim} onClick={() => setMoreOpen(false)} />
                <div className={`${styles.menu} ${styles.moreMenu}`} role="menu">
                  {NAV_ITEMS.filter((it) => !PRIMARY_IDS.includes(it.id)).map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      role="menuitem"
                      className={`${styles.menuItem} ${isActive(it.path) ? styles.menuItemActive : ""}`}
                      onClick={() => {
                        setMoreOpen(false);
                        navigate(it.path);
                      }}
                    >
                      <WebIcon name={NAV_ICONS[it.id] ?? "chevRight"} size={16} color="var(--color-muted)" />
                      {it.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </nav>

      <main className={styles.page}>
        {error ? (
          <div className={styles.loadError} role="alert">
            Could not load: {error}
          </div>
        ) : (
          children
        )}
      </main>
      <div className={styles.chatDock}>
        {chatMounted && (
          <aside
            id="fina-chat-popover"
            className={styles.chatPopover}
            role="dialog"
            aria-modal="false"
            aria-labelledby="fina-chat-title"
            hidden={!chatOpen}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeChat();
            }}
          >
            <FinaChat open={chatOpen} workspaceId={activeWsId} onClose={closeChat} />
          </aside>
        )}
        <button
          ref={chatLauncherRef}
          className={styles.chatLauncher}
          type="button"
          aria-label={chatOpen ? "Close Fina chat" : "Open Fina chat"}
          aria-expanded={chatOpen}
          aria-controls={chatMounted ? "fina-chat-popover" : undefined}
          onClick={() => {
            if (chatOpen) closeChat();
            else {
              setChatMounted(true);
              setChatOpen(true);
            }
          }}
        >
          <WebIcon name={chatOpen ? "x" : "sparkle"} size={19} strokeWidth={2} />
          <span>{chatOpen ? "Close" : "Ask Fina"}</span>
        </button>
      </div>
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
        <span className={styles.wsBtnName}>{active.name}</span>
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
          <div className={`${styles.menu} ${styles.wsMenu}`}>
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
                <span className={styles.menuItemGrow}>{w.name}</span>
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
  showIdentity = false,
}: {
  email: string;
  name?: string | null | undefined;
  initialsText: string;
  onNavigate: (path: string) => void;
  onSignOut: () => void;
  /** Sidebar footer: show the name and email beside the avatar. */
  showIdentity?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`${styles.wsWrap} ${showIdentity ? styles.userWrap : ""}`}>
      <button
        type="button"
        className={showIdentity ? styles.userBtn : styles.avatarBtn}
        onClick={() => setOpen((o) => !o)}
        title={name ?? email}
      >
        {showIdentity ? (
          <>
            <span className={styles.avatar}>{initialsText}</span>
            <span className={styles.userText}>
              <span className={styles.userName}>{name || email}</span>
              {name && <span className={styles.userMail}>{email}</span>}
            </span>
            <WebIcon name="chevDown" size={14} strokeWidth={2} />
          </>
        ) : (
          initialsText
        )}
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
