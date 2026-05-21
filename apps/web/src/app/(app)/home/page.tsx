"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  displayName,
  trialDaysLeft,
  type MeDTO as Me,
  type WorkspaceSummary as Workspace,
} from "@fina/shared";
import { useSession } from "../../../auth/client";
import { apiFetch, bootstrapActiveWorkspace } from "../../../lib/api";
import { getActiveWorkspaceId } from "../../../lib/active-workspace";
import { WebIcon } from "../../../components/WebIcon";
import styles from "./home.module.css";

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
  const { data: session } = useSession();
  const [me, setMe] = useState<Me | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
        setWorkspace(
          wsData.workspaces.find((w) => w.id === activeId) ??
            wsData.workspaces[0] ??
            null,
        );
      } catch (e) {
        setErr((e as { code?: string }).code ?? "load_error");
      }
    })();
  }, []);

  if (err) {
    return (
      <div className={styles.container}>
        <p style={{ color: "var(--color-down)" }}>Could not load: {err}</p>
      </div>
    );
  }

  const days = me ? trialDaysLeft(me.trial.endsAt) : null;
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

      {isTrial && (
        <div className={`${styles.banner} ${styles.bannerTrial}`}>
          <span className={styles.bannerIcon}>
            <WebIcon name="sparkle" size={20} strokeWidth={1.8} />
          </span>
          <div className={styles.bannerBody}>
            <div className={styles.bannerTitle}>
              You&apos;re on Pro trial — {days}{" "}
              {days === 1 ? "day" : "days"} left
            </div>
            <div className={styles.bannerSub}>
              Add a card to keep Pro at $15/mo when the trial ends.
            </div>
          </div>
          <button
            type="button"
            className={styles.bannerBtn}
            onClick={() => router.push("/settings/plan")}
          >
            Stay on Pro
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
              {/* Member count placeholder — wire to /workspaces/:id/members later */}
              <span>Just you</span>
            </div>
            <div className={styles.wsCardFoot}>
              <div style={{ fontSize: 13, color: "var(--color-body)" }}>
                <strong style={{ color: "var(--color-ink)" }}>0</strong> banks
                connected
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

        <div className={styles.mobileCta}>
          <div>
            <div className={styles.mobileCtaEyebrow}>
              Where Fina really lives
            </div>
            <h2 className={styles.mobileCtaTitle}>
              Open the app every morning for your brief.
            </h2>
            <p className={styles.mobileCtaSub}>
              Chat, daily ritual, and one-tap categorize live on your phone.
              Web is for setup and billing.
            </p>
            <div className={styles.mobileCtaBadges}>
              <a className={styles.mobileCtaBadge} href="#">
                <div>
                  <div className={styles.mobileCtaBadgeLine1}>
                    Download on the
                  </div>
                  <div className={styles.mobileCtaBadgeLine2}>App Store</div>
                </div>
              </a>
              <a className={styles.mobileCtaBadge} href="#">
                <div>
                  <div className={styles.mobileCtaBadgeLine1}>Get it on</div>
                  <div className={styles.mobileCtaBadgeLine2}>Google Play</div>
                </div>
              </a>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Set up your account</div>
            <div className={styles.sectionSub}>
              Three things to do before you open the mobile app.
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
            <div className={styles.quickLinkTitle}>
              Connect your first bank
            </div>
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
              Free, Lite, or Pro. Add a card before your trial ends to stay on
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
