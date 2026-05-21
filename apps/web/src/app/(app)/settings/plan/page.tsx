"use client";

import { Fragment, useEffect, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import { WebIcon } from "../../../../components/WebIcon";
import styles from "../settings.module.css";

type Me = {
  user: { id: string; email: string };
  tier: "free" | "lite" | "pro";
  trial: { active: boolean; endsAt: string | null };
};

type PlanKey = "free" | "lite" | "pro";

const PLANS: Record<PlanKey, { name: string; price: number }> = {
  free: { name: "Free", price: 0 },
  lite: { name: "Lite", price: 7 },
  pro: { name: "Pro", price: 15 },
};

type CompareRow = {
  label: string;
  free: string | boolean;
  lite: string | boolean;
  pro: string | boolean;
  highlight?: boolean;
};

const COMPARE_ROWS: CompareRow[] = [
  { label: "Bank connections", free: "None", lite: "1 bank", pro: "Unlimited", highlight: true },
  { label: "AI chat", free: "No", lite: "Daily ritual only", pro: "Full two-way chat", highlight: true },
  { label: "Daily morning brief", free: false, lite: true, pro: true },
  { label: "Workspace sharing", free: true, lite: true, pro: true },
  { label: "Manual entry", free: true, lite: true, pro: true },
  { label: "CSV import", free: true, lite: true, pro: true },
  { label: "Support", free: "Email", lite: "Email", pro: "Priority email" },
];

function daysLeft(endsAt: string | null): number | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-CA", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function PlanPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Me>("/me")
      .then(setMe)
      .catch((e) => setErr((e as { code?: string }).code ?? "load_error"));
  }, []);

  if (err) {
    return (
      <div className={styles.container}>
        <p style={{ color: "var(--color-down)" }}>Could not load: {err}</p>
      </div>
    );
  }
  if (!me) {
    return <div className={styles.container} />;
  }

  const isTrial = me.trial.active;
  const tier = me.tier;
  const currentForCompare: PlanKey = isTrial ? "pro" : tier;
  const days = daysLeft(me.trial.endsAt);
  const trialEnds = formatDate(me.trial.endsAt);

  const onCheckout = (_plan: PlanKey) => {
    // TODO: open Stripe checkout when billing is wired
    alert("Billing isn't wired yet. Stripe checkout will go here.");
  };

  return (
    <div className={styles.container}>
      <div className={styles.head}>
        <h1 className={styles.title}>Plan &amp; billing</h1>
        <p className={styles.sub}>
          Subscriptions are per-user. Members can be on different tiers in
          the same workspace.
        </p>
      </div>

      <div className={styles.section}>
        <div
          className={`${styles.planCurrent} ${isTrial ? styles.withAside : ""}`}
        >
          <div>
            <div className={styles.planCurrentLabel}>Your plan</div>
            <div className={styles.planCurrentName}>
              {isTrial ? "Pro" : PLANS[tier].name}
              <span
                className={`${styles.pill} ${
                  isTrial
                    ? styles.pillWarn
                    : tier === "free"
                      ? styles.pillNeutral
                      : styles.pillActive
                }`}
              >
                <span className={styles.pillDot} />
                {isTrial
                  ? "Trial"
                  : tier === "free"
                    ? "Free tier"
                    : "Active"}
              </span>
            </div>
            <div className={styles.planCurrentStatus}>
              {isTrial && (
                <>
                  Trial ends <strong>{trialEnds}</strong>. After trial,
                  you&apos;ll move to Free unless you add a payment method.
                </>
              )}
              {tier === "pro" && !isTrial && <>${PLANS.pro.price}/mo</>}
              {tier === "lite" && !isTrial && <>${PLANS.lite.price}/mo</>}
              {tier === "free" && !isTrial && (
                <>
                  No active subscription. Bank connections and AI features are
                  locked.
                </>
              )}
            </div>
            <div className={styles.planCurrentActions}>
              {isTrial && (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={() => onCheckout("pro")}
                >
                  Add payment method
                </button>
              )}
              {(tier === "pro" || tier === "lite") && !isTrial && (
                <>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnOutline}`}
                  >
                    Update payment method
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost}`}
                  >
                    Cancel subscription
                  </button>
                </>
              )}
              {tier === "free" && !isTrial && (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  onClick={() => onCheckout("pro")}
                >
                  Start a plan
                </button>
              )}
            </div>
          </div>

          {isTrial && days !== null && (
            <div className={styles.planTrialAside}>
              <div className={styles.planTrialAsideDays}>{days}</div>
              <div className={styles.planTrialAsideLabel}>Days left on trial</div>
              <div className={styles.planTrialAsideDate}>Ends {trialEnds}</div>
            </div>
          )}
        </div>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionHead}>
          <div>
            <div className={styles.sectionTitle}>Compare plans</div>
            <div className={styles.sectionSub}>
              Headline prices in CAD. Subscriptions purchased in the iOS or
              Android app are managed in the App Store or Google Play.
            </div>
          </div>
        </div>

        <div className={styles.compare}>
          <div className={`${styles.compareCell} ${styles.header}`}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: "var(--color-muted)",
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              For one user
            </div>
            <div
              style={{
                fontSize: 13,
                color: "var(--color-muted)",
                marginTop: 4,
              }}
            >
              Monthly billing
            </div>
          </div>
          {(["free", "lite", "pro"] as PlanKey[]).map((k) => {
            const isCurrent = k === currentForCompare;
            return (
              <div
                key={k}
                className={`${styles.compareCell} ${styles.header} ${isCurrent ? styles.compareCellCurrent : ""}`}
              >
                <div className={styles.compareTier}>{PLANS[k].name}</div>
                <div className={styles.comparePrice}>
                  ${PLANS[k].price}
                  <small>/mo</small>
                </div>
                {isCurrent && (
                  <span className={styles.compareCurrentPill}>
                    {isTrial ? "Current · trial" : "Current"}
                  </span>
                )}
              </div>
            );
          })}

          {COMPARE_ROWS.map((row, ri) => (
            <Fragment key={ri}>
              <div className={`${styles.compareCell} ${styles.label}`}>
                {row.label}
              </div>
              {(["free", "lite", "pro"] as PlanKey[]).map((k) => {
                const v = row[k];
                return (
                  <div key={k} className={styles.compareCell}>
                    {v === true ? (
                      <WebIcon
                        name="check"
                        size={18}
                        strokeWidth={2.2}
                        color="var(--color-up)"
                      />
                    ) : v === false ? (
                      <span className={styles.compareNo}>
                        <WebIcon name="x" size={16} strokeWidth={2} />
                      </span>
                    ) : (
                      <span
                        style={
                          row.highlight
                            ? { fontWeight: 500, color: "var(--color-ink)" }
                            : undefined
                        }
                      >
                        {v}
                      </span>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}

          <div
            className={`${styles.compareCell} ${styles.foot}`}
            style={{
              alignItems: "center",
              color: "var(--color-muted)",
              fontSize: 13,
            }}
          >
            Choose a plan
          </div>
          {(["free", "lite", "pro"] as PlanKey[]).map((k) => {
            const isCurrent = k === currentForCompare;
            const lower =
              (k === "free" &&
                (currentForCompare === "lite" || currentForCompare === "pro")) ||
              (k === "lite" && currentForCompare === "pro");
            const higher = !isCurrent && !lower;
            return (
              <div key={k} className={`${styles.compareCell} ${styles.foot}`}>
                {isCurrent ? (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnOutline}`}
                    disabled
                  >
                    Current plan
                  </button>
                ) : lower ? (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnOutline}`}
                    onClick={() => onCheckout(k)}
                  >
                    Downgrade
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => onCheckout(k)}
                  >
                    {higher && tier === "free" && !isTrial
                      ? `Start ${PLANS[k].name}`
                      : `Upgrade to ${PLANS[k].name}`}
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className={styles.billingFootnote}>
          <strong style={{ color: "var(--color-ink)" }}>
            Subscribed via mobile?
          </strong>{" "}
          Subscriptions purchased through the iOS or Android app are billed by
          Apple or Google and managed in those stores — not here.
        </div>
      </div>
    </div>
  );
}
