"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  PRICING,
  TIER_LIMITS,
  trialDaysLeft,
  trialRevertsTo,
  tierLabel,
  formatShortDate,
  type MeDTO,
  type SubscriptionDTO,
  type PaidTier,
} from "@fina/shared";
import { apiFetch } from "../../../../lib/api";
import styles from "../settings.module.css";

export default function PlanPage() {
  const router = useRouter();
  const [me, setMe] = useState<MeDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "checkout-pro" | "checkout-max" | "portal">(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await apiFetch<MeDTO>("/me"));
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("status");
    const sessionId = params.get("sessionId") ?? undefined;
    if (status === "success") {
      // POST /billing/sync first (codex R2), then strip query, then refresh.
      (async () => {
        try {
          const m = await apiFetch<MeDTO>("/billing/sync", {
            method: "POST",
            body: JSON.stringify({ sessionId }),
          });
          setMe(m);
        } catch (e) {
          setErr((e as { code?: string }).code ?? "sync_error");
        }
        router.replace("/settings/plan");
      })();
    } else {
      refresh();
    }
  }, [refresh, router]);

  if (err) {
    return (
      <div className={styles.container}>
        <p style={{ color: "var(--color-down)" }}>Could not load plan: {err}</p>
      </div>
    );
  }
  if (!me) return <div className={styles.container}>Loading…</div>;

  const onUpgrade = async (tier: PaidTier) => {
    setBusy(tier === "max" ? "checkout-max" : "checkout-pro");
    try {
      const { url } = await apiFetch<{ url: string }>("/billing/checkout", {
        method: "POST",
        body: JSON.stringify({ tier }),
      });
      window.location.href = url;
    } catch (e) {
      setErr((e as { code?: string }).code ?? "checkout_failed");
      setBusy(null);
    }
  };

  const onManage = async () => {
    setBusy("portal");
    try {
      const { url } = await apiFetch<{ url: string }>("/billing/portal", { method: "POST" });
      window.location.href = url;
    } catch (e) {
      setErr((e as { code?: string }).code ?? "portal_failed");
      setBusy(null);
    }
  };

  const trialActive = me.trial.active;
  const days = trialDaysLeft(me.trial.endsAt);
  const sub: SubscriptionDTO | null = me.subscription;

  const renderCurrentCard = () => {
    // Decision matrix from spec §"MeDTO extension" → "UI decision matrix".
    if (trialActive && !sub) {
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>Pro trial</div>
            <div className={styles.planCurrentStatus}>
              {days != null ? `${days} day${days === 1 ? "" : "s"} left` : ""}
              {" · Add a card to keep Pro after your trial ends."}
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={() => onUpgrade("pro")}
              disabled={busy !== null}
            >
              {busy === "checkout-pro" ? "Opening…" : "Add card · Stay on Pro"}
            </button>
          </div>
        </div>
      );
    }
    if (trialActive && sub) {
      // Trial active AND a paid sub on file. `revertsTo` is non-null only when
      // the post-trial tier is below Pro (a downgrade to warn about); it
      // already folds in a scheduled pendingTier. When null, keep the existing
      // charge / scheduled-switch copy untouched.
      const revertsTo = trialRevertsTo(me);
      const upcomingTier =
        sub.pendingTier && sub.pendingTier !== sub.tier ? sub.pendingTier : sub.tier;
      const upcomingLabel = tierLabel(upcomingTier, false);
      const upcomingPrice = PRICING[upcomingTier].displayPrice;
      const at = new Date(sub.currentPeriodEnd).toLocaleDateString();
      const hasSchedule = sub.pendingTier && sub.pendingTier !== sub.tier;
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>Pro trial</div>
            <div className={styles.planCurrentStatus}>
              {days != null ? `${days} day${days === 1 ? "" : "s"} left.` : ""}{" "}
              {revertsTo
                ? `Switches to ${tierLabel(revertsTo, false)} on ${formatShortDate(me.trial.endsAt)}. ${upcomingPrice} will be charged.`
                : hasSchedule
                  ? `Switches to ${upcomingLabel} on ${at}. ${upcomingPrice} will be charged.`
                  : `${upcomingPrice} will be charged on ${at}.`}
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={onManage}
              disabled={busy !== null}
            >
              {busy === "portal" ? "Opening…" : "Manage subscription"}
            </button>
          </div>
        </div>
      );
    }
    if (sub && sub.status === "past_due") {
      return (
        <div className={styles.planCurrent} style={{ borderColor: "var(--color-down)" }}>
          <div>
            <div className={styles.planCurrentLabel} style={{ color: "var(--color-down)" }}>
              Payment failed
            </div>
            <div className={styles.planCurrentName}>{tierLabel(sub.tier, false)}</div>
            <div className={styles.planCurrentStatus}>
              Update your card to keep your subscription active.
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={onManage}
              disabled={busy !== null}
            >
              Update card
            </button>
          </div>
        </div>
      );
    }
    if (sub && sub.cancelAtPeriodEnd) {
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>{tierLabel(sub.tier, false)}</div>
            <div className={styles.planCurrentStatus}>
              Ends on {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={onManage}
              disabled={busy !== null}
            >
              Resume
            </button>
          </div>
        </div>
      );
    }
    if (sub && sub.pendingTier && sub.pendingTier !== sub.tier) {
      const currentLabel = tierLabel(sub.tier, false);
      const nextLabel = tierLabel(sub.pendingTier, false);
      const at = sub.pendingTierAt
        ? new Date(sub.pendingTierAt).toLocaleDateString()
        : new Date(sub.currentPeriodEnd).toLocaleDateString();
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>{currentLabel}</div>
            <div className={styles.planCurrentStatus}>
              Switches to {nextLabel} on {at}. {PRICING[sub.pendingTier].displayPrice} will be charged.
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={onManage}
              disabled={busy !== null}
            >
              Manage subscription
            </button>
          </div>
        </div>
      );
    }
    if (sub) {
      return (
        <div className={styles.planCurrent}>
          <div>
            <div className={styles.planCurrentLabel}>Current plan</div>
            <div className={styles.planCurrentName}>{tierLabel(sub.tier, false)}</div>
            <div className={styles.planCurrentStatus}>
              Renews on {new Date(sub.currentPeriodEnd).toLocaleDateString()}
            </div>
          </div>
          <div className={styles.planCurrentActions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnOutline}`}
              onClick={onManage}
              disabled={busy !== null}
            >
              Manage subscription
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className={styles.planCurrent}>
        <div>
          <div className={styles.planCurrentLabel}>Current plan</div>
          <div className={styles.planCurrentName}>Free</div>
          <div className={styles.planCurrentStatus}>
            Upgrade to reconnect a bank with automatic syncing.
          </div>
        </div>
      </div>
    );
  };

  const renderUpgradeButton = (tier: PaidTier) => {
    const isCurrent = sub?.tier === tier && !sub?.cancelAtPeriodEnd;
    if (isCurrent) {
      return (
        <button type="button" className={`${styles.btn} ${styles.btnOutline}`} disabled>
          Current plan
        </button>
      );
    }
    // Tier change (Pro ↔ Max) flows through Stripe Customer Portal so
    // Stripe handles proration + immediate switch on an existing
    // subscription. Checkout (creating a new sub) is only correct when
    // the user has no active subscription yet.
    if (sub !== null) {
      // A scheduled change is already in flight for this tier — let the
      // user manage it via Portal rather than queuing another change.
      if (sub.pendingTier === tier) {
        return (
          <button type="button" className={`${styles.btn} ${styles.btnOutline}`} disabled>
            Switch scheduled
          </button>
        );
      }
      const label = tierLabel(tier, false);
      const isDown = sub.tier === "max" && tier === "pro";
      return (
        <button
          type="button"
          className={`${styles.btn} ${isDown ? styles.btnOutline : styles.btnPrimary}`}
          onClick={onManage}
          disabled={busy !== null}
        >
          {busy === "portal" ? "Opening…" : `Switch to ${label}`}
        </button>
      );
    }
    return (
      <button
        type="button"
        className={`${styles.btn} ${styles.btnPrimary}`}
        onClick={() => onUpgrade(tier)}
        disabled={busy !== null}
      >
        {busy === (tier === "max" ? "checkout-max" : "checkout-pro")
          ? "Opening…"
          : `Upgrade to ${tierLabel(tier, false)}`}
      </button>
    );
  };

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <h1 className={styles.title}>Plan & billing</h1>
        <p className={styles.sub}>Manage your Fina subscription.</p>
      </div>

      {renderCurrentCard()}

      <div className={styles.section} style={{ marginTop: 48 }}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Compare plans</div>
          </div>
        </div>
        <div className={styles.card}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 12 }}></th>
                <th style={{ textAlign: "left", padding: 12 }}>Free</th>
                <th style={{ textAlign: "left", padding: 12 }}>
                  Pro · {PRICING.pro.displayPrice} <span style={{ opacity: 0.6 }}>/ mo</span>
                  <span className={`${styles.pill} ${styles.pillActive}`} style={{ marginLeft: 8 }}>
                    Recommended
                  </span>
                </th>
                <th style={{ textAlign: "left", padding: 12 }}>
                  Max · {PRICING.max.displayPrice} <span style={{ opacity: 0.6 }}>/ mo</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderTop: "1px solid var(--color-hairline-soft)" }}>
                <td style={{ padding: 12 }}>Bank connections</td>
                <td style={{ padding: 12 }}>0 (manual / CSV)</td>
                <td style={{ padding: 12 }}>{TIER_LIMITS.pro.plaidItems}</td>
                <td style={{ padding: 12 }}>{TIER_LIMITS.max.plaidItems}</td>
              </tr>
              <tr style={{ borderTop: "1px solid var(--color-hairline-soft)" }}>
                <td style={{ padding: 12 }}>AI advisor chat</td>
                <td style={{ padding: 12 }}>—</td>
                <td style={{ padding: 12 }}>Full two-way</td>
                <td style={{ padding: 12 }}>Full two-way</td>
              </tr>
              <tr style={{ borderTop: "1px solid var(--color-hairline-soft)" }}>
                <td style={{ padding: 12 }}>AI usage</td>
                <td style={{ padding: 12 }}>—</td>
                <td style={{ padding: 12 }}>Standard</td>
                <td style={{ padding: 12 }}>Expanded</td>
              </tr>
              <tr style={{ borderTop: "1px solid var(--color-hairline-soft)" }}>
                <td style={{ padding: 12 }}>Workspace sharing</td>
                <td style={{ padding: 12 }}>✓</td>
                <td style={{ padding: 12 }}>✓</td>
                <td style={{ padding: 12 }}>✓</td>
              </tr>
              <tr style={{ borderTop: "1px solid var(--color-hairline-soft)" }}>
                <td style={{ padding: 12 }}></td>
                <td style={{ padding: 12 }}></td>
                <td style={{ padding: 12 }}>{renderUpgradeButton("pro")}</td>
                <td style={{ padding: 12 }}>{renderUpgradeButton("max")}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <p className={styles.sectionSub} style={{ marginTop: 24 }}>
        Subscriptions purchased through the iOS or Android app are managed in
        the App Store / Google Play, not here.
      </p>
    </div>
  );
}
