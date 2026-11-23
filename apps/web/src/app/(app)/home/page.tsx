"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  displayName,
  STRIPE_PRICING,
  trialDaysLeft,
  tierLabel,
  trialRevertsTo,
  formatShortDate,
  type MeDTO as Me,
  type WorkspaceSummary as Workspace,
  type Member,
  type PlaidItemDTO,
  type AnalysisResponse,
  type TransactionsResponse,
} from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../lib/api";
import {
  getActiveWorkspaceId,
  setActiveWorkspaceId,
} from "../../../lib/active-workspace";
import { WebIcon } from "../../../components/WebIcon";
import { formatMoney } from "../../../lib/money";
import styles from "./home.module.css";

type IncomingInvite = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  inviterEmail: string;
  inviterName: string | null;
  invitedRole: "editor" | "viewer";
  expiresAt: string;
  createdAt: string;
};

function formatToday(): string {
  return new Date().toLocaleDateString("en-CA", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function firstName(me: Me | null): string {
  return me ? displayName(me.user) : "there";
}

export default function HomePage() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [bankCount, setBankCount] = useState<number | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [recent, setRecent] = useState<TransactionsResponse["transactions"]>([]);
  const [incoming, setIncoming] = useState<IncomingInvite[]>([]);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadIncoming = useCallback(async () => {
    try {
      const r = await apiFetch<{ invites: IncomingInvite[] }>(
        "/me/incoming-invites",
      );
      setIncoming(r.invites);
    } catch {
      // Non-fatal — banner just won't render.
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await bootstrapActiveWorkspace();
        const [meData, wsData] = await Promise.all([
          apiFetch<Me>("/me"),
          apiFetch<{ workspaces: Workspace[] }>("/workspaces"),
        ]);
        setMe(meData);
        const activeId = getActiveWorkspaceId();
        const active =
          wsData.workspaces.find((w) => w.id === activeId) ??
          wsData.workspaces[0] ??
          null;
        setWorkspace(active);
        loadIncoming();

        if (active) {
          // Pull member + bank counts in parallel; tolerate either failing
          // (the card just falls back to its loading state).
          const [membersRes, plaidRes, analysisRes, transactionsRes] = await Promise.allSettled([
            apiFetch<{ members: Member[] }>(`/workspaces/${active.id}/members`),
            apiFetch<{ plaidItems: PlaidItemDTO[] }>(
              `/workspaces/${active.id}/plaid-items`,
            ),
            apiFetch<AnalysisResponse>(`/workspaces/${active.id}/analysis`),
            apiFetch<TransactionsResponse>(`/workspaces/${active.id}/transactions?limit=5`),
          ]);
          if (membersRes.status === "fulfilled") {
            setMemberCount(membersRes.value.members.length);
          }
          if (plaidRes.status === "fulfilled") {
            setBankCount(plaidRes.value.plaidItems.filter((item) => item.status !== "disconnected").length);
          }
          if (analysisRes.status === "fulfilled") setAnalysis(analysisRes.value);
          if (transactionsRes.status === "fulfilled") setRecent(transactionsRes.value.transactions);
        }
      } catch (e) {
        setErr((e as { code?: string }).code ?? "load_error");
      }
    })();
  }, [loadIncoming]);

  const acceptInvite = useCallback(
    async (inv: IncomingInvite) => {
      setAcceptingId(inv.id);
      try {
        const r = await apiFetch<{ workspaceId: string; role: string }>(
          `/me/incoming-invites/${inv.id}/accept`,
          { method: "POST" },
        );
        // Make the newly-joined workspace active so the user lands
        // inside it (not whatever they had open before). Full page
        // navigate so every consumer of /workspaces refetches.
        setActiveWorkspaceId(r.workspaceId);
        setIncoming((prev) => prev.filter((i) => i.id !== inv.id));
        window.location.href = "/home";
      } catch (e) {
        setErr((e as { code?: string }).code ?? "accept_failed");
      } finally {
        setAcceptingId(null);
      }
    },
    [],
  );

  if (err) {
    return (
      <div className={styles.container}>
        <p style={{ color: "var(--color-down)" }}>Could not load: {err}</p>
      </div>
    );
  }

  const days = me ? trialDaysLeft(me.trial.endsAt) : null;
  const revertsTo = me ? trialRevertsTo(me) : null;
  const isTrial = !!me?.trial.active;
  const isFree = me?.tier === "free" && !me.trial.active;

  return (
    <div className={styles.container}>
      <div className={styles.welcome}>
        <h1 className={styles.greeting}>
          Welcome back, <em>{firstName(me)}</em>
        </h1>
        <div className={styles.date}>{formatToday()}</div>
      </div>

      {incoming.length > 0 && (
        <div className={styles.inviteBanners}>
          {incoming.map((inv) => {
            const fromLabel = inv.inviterName?.trim().length
              ? inv.inviterName
              : inv.inviterEmail;
            return (
              <div
                key={inv.id}
                className={`${styles.banner} ${styles.bannerInvite}`}
              >
                <span className={styles.bannerIcon}>
                  <WebIcon name="users" size={20} strokeWidth={1.8} />
                </span>
                <div className={styles.bannerBody}>
                  <div className={styles.bannerTitle}>
                    {fromLabel} invited you to {inv.workspaceName}
                  </div>
                  <div className={styles.bannerSub}>
                    Join as {inv.invitedRole} to see their transactions,
                    categories, and budgets.
                  </div>
                </div>
                <button
                  type="button"
                  className={styles.bannerBtn}
                  onClick={() => acceptInvite(inv)}
                  disabled={acceptingId === inv.id}
                >
                  {acceptingId === inv.id ? "Joining…" : "Accept"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {isTrial && (
        <div className={`${styles.banner} ${styles.bannerTrial}`}>
          <span className={styles.bannerIcon}>
            <WebIcon name="sparkle" size={20} strokeWidth={1.8} />
          </span>
          <div className={styles.bannerBody}>
            <div className={styles.bannerTitle}>
              You&apos;re on Pro trial · {days}{" "}
              {days === 1 ? "day" : "days"} left
            </div>
            <div className={styles.bannerSub}>
              {revertsTo
                ? `${tierLabel(revertsTo, false)} starts on ${formatShortDate(me?.trial.endsAt)}.`
                : `Add a card to keep Pro at ${STRIPE_PRICING.pro.displayPrice}/mo when the trial ends.`}
            </div>
          </div>
          <button
            type="button"
            className={styles.bannerBtn}
            onClick={() => router.push("/settings/plan")}
          >
            {revertsTo ? "Manage plan" : "Stay on Pro"}
          </button>
        </div>
      )}

      {isFree && (
        <div className={`${styles.banner} ${styles.bannerExpired}`}>
          <span className={styles.bannerIcon}>
            <WebIcon name="alert" size={20} strokeWidth={1.8} />
          </span>
          <div className={styles.bannerBody}>
            <div className={styles.bannerTitle}>Your trial ended</div>
            <div className={styles.bannerSub}>
              Upgrade to keep Plaid bank connections and AI features.
            </div>
          </div>
          <button
            type="button"
            className={styles.bannerBtn}
            onClick={() => router.push("/settings/plan")}
          >
            Upgrade
          </button>
        </div>
      )}

      <div className={styles.grid2}>
        {workspace && (
          <div className={styles.wsCard}>
            <div className={styles.eyebrow}>Workspace</div>
            <div className={styles.wsCardName}>{workspace.name}</div>
            <div className={styles.wsCardMeta}>
              <span
                className={`${styles.pill} ${workspace.role === "owner" ? styles.pillOwner : ""}`}
              >
                <span className={styles.pillDot} />
                {workspace.role}
              </span>
              <span>
                {memberCount === null
                  ? "…"
                  : memberCount === 1
                    ? "Just you"
                    : `${memberCount} members`}
              </span>
            </div>
            <div className={styles.wsCardFoot}>
              <div style={{ fontSize: 13, color: "var(--color-body)" }}>
                <strong style={{ color: "var(--color-ink)" }}>
                  {bankCount ?? "…"}
                </strong>{" "}
                {bankCount === 1 ? "bank" : "banks"} connected
              </div>
              <button
                type="button"
                className={styles.link}
                onClick={() => router.push("/settings/workspace")}
              >
                Manage →
              </button>
            </div>
          </div>
        )}

        <div className={styles.cashflowCard}>
          <div className={styles.eyebrow}>{analysis?.current.label ?? "Latest month"} cashflow</div>
          {analysis ? (
            <div className={styles.cashflowGrid}>
              <div><span>Income</span><strong>{formatMoney(analysis.current.income, workspace?.currency ?? "CAD")}</strong></div>
              <div><span>Expenses</span><strong>{formatMoney(analysis.current.spend, workspace?.currency ?? "CAD")}</strong></div>
              <div><span>Net</span><strong>{formatMoney(analysis.current.net, workspace?.currency ?? "CAD")}</strong></div>
            </div>
          ) : <p className={styles.sectionSub}>Your cashflow will appear here when you add transactions.</p>}
          <button className={styles.link} type="button" onClick={() => router.push("/analysis")}>Open analysis →</button>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div><div className={styles.sectionTitle}>Recent activity</div><div className={styles.sectionSub}>Your latest income and expenses.</div></div>
          <button className={styles.link} type="button" onClick={() => router.push("/activity")}>View all →</button>
        </div>
        <div className={styles.recentCard}>
          {recent.length === 0 ? <p className={styles.sectionSub}>No transactions yet. Add one in Activity.</p> : recent.map((transaction) => (
            <div className={styles.recentRow} key={transaction.id}>
              <div><strong>{transaction.merchantNormalized ?? transaction.merchantRaw}</strong><span>{new Date(transaction.occurredAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</span></div>
              <strong className={Number(transaction.amount) < 0 ? styles.recentIncome : ""}>{formatMoney(Math.abs(Number(transaction.amount)), transaction.currency)}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Manage your workspace</div>
            <div className={styles.sectionSub}>
              Connections, household access, and your plan.
            </div>
          </div>
        </div>
        <div className={styles.grid3}>
          <button
            type="button"
            className={styles.quickLink}
            onClick={() => router.push("/settings/banks")}
          >
            <span className={styles.quickLinkGlyph}>
              <WebIcon name="bank" size={20} />
            </span>
            <div className={styles.quickLinkTitle}>Manage banks</div>
            <div className={styles.quickLinkSub}>
              Transactions start syncing the moment you connect.
            </div>
            <span className={styles.quickLinkArrow}>
              Open <WebIcon name="arrowRight" size={14} strokeWidth={2} />
            </span>
          </button>

          <button
            type="button"
            className={styles.quickLink}
            onClick={() => router.push("/settings/workspace")}
          >
            <span className={styles.quickLinkGlyph}>
              <WebIcon name="users" size={20} />
            </span>
            <div className={styles.quickLinkTitle}>
              Invite a household member
            </div>
            <div className={styles.quickLinkSub}>
              Share categories and budgets with the people you live with.
            </div>
            <span className={styles.quickLinkArrow}>
              Open <WebIcon name="arrowRight" size={14} strokeWidth={2} />
            </span>
          </button>

          <button
            type="button"
            className={styles.quickLink}
            onClick={() => router.push("/settings/plan")}
          >
            <span className={styles.quickLinkGlyph}>
              <WebIcon name="card" size={20} />
            </span>
            <div className={styles.quickLinkTitle}>Choose your plan</div>
            <div className={styles.quickLinkSub}>
              Free, Pro, or Max. Add a card before your trial ends to stay on
              Pro.
            </div>
            <span className={styles.quickLinkArrow}>
              Open <WebIcon name="arrowRight" size={14} strokeWidth={2} />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
