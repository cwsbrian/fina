import styles from "../legal.module.css";

export const metadata = {
  title: "Account & Data Deletion · Fina",
  description:
    "How to permanently delete your Fina account and the data we retain after deletion.",
};

export default function AccountDeletion() {
  return (
    <>
      <h1>Account & Data Deletion</h1>
      <p className={styles.meta}>Last updated: May 27, 2026</p>

      <p>
        You can permanently delete your Fina account and all data associated
        with it at any time. This page explains how, what gets deleted, and
        what we retain.
      </p>

      <h2>1. How to delete your account</h2>

      <h3>Self-service (recommended)</h3>
      <ol>
        <li>
          Sign in to Fina at{" "}
          <a href="https://withfina.com">withfina.com</a>.
        </li>
        <li>
          Go to <strong>Settings → Account</strong> (direct link:{" "}
          <a href="https://withfina.com/settings/account">
            withfina.com/settings/account
          </a>
          ).
        </li>
        <li>
          Scroll to the <strong>Delete account</strong> section at the bottom.
        </li>
        <li>
          Click <strong>Delete account</strong> and confirm. The deletion is
          immediate and irreversible.
        </li>
      </ol>

      <h3>By email (if you cannot sign in)</h3>
      <p>
        Email <a href="mailto:cwsbrian@gmail.com">cwsbrian@gmail.com</a> from
        the address on your Fina account. We honor deletion requests within
        30 days.
      </p>

      <h2>2. What gets deleted</h2>
      <ul>
        <li>
          Your account record (email, password hash, display name, email-
          verification status).
        </li>
        <li>
          Every workspace you own — including all linked banks, transactions
          (raw Plaid data), categories, budgets, scheduled spends, recurring
          expenses, goals, chat threads and messages.
        </li>
        <li>
          Any active Plaid item access tokens — revoked at Plaid as part of
          deletion.
        </li>
        <li>
          Push notification tokens registered to your account.
        </li>
        <li>
          Any active subscription metadata stored on our side (the underlying
          Stripe / Apple / Google subscription itself must be cancelled
          through that provider — see §4).
        </li>
      </ul>

      <h2>3. What we retain (and why)</h2>
      <ul>
        <li>
          <strong>Workspaces you joined as a member (not owner)</strong> —
          your membership row is removed, but the workspace itself and its
          data belong to the owner and remain intact for them.
        </li>
        <li>
          <strong>Anonymized billing records</strong> — Stripe / Apple /
          Google retain payment records under their respective tax and
          accounting obligations. We do not store credit card numbers.
        </li>
        <li>
          <strong>Operational logs (≤ 30 days)</strong> — request logs at our
          hosting provider may contain your account id for up to 30 days
          before automatic rotation. After that window, no personally-
          identifiable trace of you remains in our systems.
        </li>
      </ul>

      <h2>4. Cancelling your subscription</h2>
      <p>
        Account deletion does <strong>not</strong> cancel an active paid
        subscription. Cancel separately through:
      </p>
      <ul>
        <li>
          <strong>Web (Stripe)</strong> — Settings → Billing → Manage
          subscription → Cancel.
        </li>
        <li>
          <strong>iOS (Apple)</strong> — Settings app → [your name] →
          Subscriptions → Fina → Cancel.
        </li>
        <li>
          <strong>Android (Google Play)</strong> — Play Store → Subscriptions
          → Fina → Cancel.
        </li>
      </ul>
      <p>
        If you delete your account while a subscription is still active, the
        subscription will continue to bill through its provider until you
        cancel it there.
      </p>

      <h2>5. Questions</h2>
      <p>
        Email <a href="mailto:cwsbrian@gmail.com">cwsbrian@gmail.com</a>. We
        respond within 5 business days.
      </p>
    </>
  );
}
