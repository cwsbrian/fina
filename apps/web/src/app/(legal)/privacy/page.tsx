import styles from "../legal.module.css";

export const metadata = {
  title: "Privacy Policy · Fina",
  description: "How Fina collects, uses, and protects your data.",
};

export default function Privacy() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className={styles.meta}>Last updated: May 26, 2026</p>

      <p>
        Fina (&quot;we&quot;, &quot;us&quot;) is a personal finance application
        operated by Brian Choi. This Privacy Policy explains what information
        we collect from you, how we use it, who we share it with, and the
        choices you have. It applies to <strong>withfina.com</strong>, our
        mobile app (Fina on iOS and Android), and the API at{" "}
        <strong>api.withfina.com</strong>.
      </p>

      <h2>1. Information we collect</h2>

      <h3>Information you give us</h3>
      <ul>
        <li>
          <strong>Account information</strong> — email address, password
          (stored as a bcrypt hash), and optional display name.
        </li>
        <li>
          <strong>Financial accounts</strong> — when you link a bank account
          through Plaid, you authorize Plaid to share with us the institution
          name, account names and types, account balances, and your
          transaction history. We do not see your bank login credentials —
          Plaid handles that exchange directly.
        </li>
        <li>
          <strong>Subscription details</strong> — if you subscribe to a paid
          tier, Stripe (or Apple / Google for in-app purchases) processes
          your payment. We receive your subscription status and the
          subscription identifier, but not your full credit card number.
        </li>
        <li>
          <strong>Chat content</strong> — messages you send to the Fina
          assistant. These are sent to Google&apos;s Gemini API to generate
          responses and stored in our database tied to your account.
        </li>
        <li>
          <strong>Categories, budgets, goals</strong> — any data you create
          inside the product.
        </li>
      </ul>

      <h3>Information we collect automatically</h3>
      <ul>
        <li>
          <strong>Device and usage data</strong> — IP address, user agent,
          and request paths captured by Cloudflare for security and abuse
          prevention.
        </li>
        <li>
          <strong>Analytics</strong> — aggregated, anonymized page-view data
          via Google Analytics 4 on withfina.com. Configure or opt out via
          your browser&apos;s Do Not Track setting or analytics extensions.
        </li>
        <li>
          <strong>Push notification token</strong> — if you enable
          notifications on mobile, we store an Expo push token tied to your
          account so we can deliver your daily brief and important alerts.
        </li>
      </ul>

      <h2>2. How we use information</h2>
      <ul>
        <li>Provide the Fina service — show your transactions, categorize
          them, generate insights, send notifications you&apos;ve enabled.</li>
        <li>Authenticate you and keep your account secure.</li>
        <li>Process subscription payments and manage billing status.</li>
        <li>Respond to support requests and improve the product.</li>
        <li>Comply with legal obligations and prevent fraud or abuse.</li>
      </ul>
      <p>
        We <strong>do not sell or rent</strong> your personal information to
        third parties. We <strong>do not use</strong> your transaction data
        to train our own machine-learning models or share it with advertisers.
      </p>

      <h2>3. Sub-processors we share data with</h2>
      <p>
        We share the minimum necessary data with the following service
        providers so they can perform their function for us. Each sub-
        processor is bound by its own contractual obligations and privacy
        practices.
      </p>
      <table>
        <thead>
          <tr>
            <th>Sub-processor</th>
            <th>Purpose</th>
            <th>Data shared</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Plaid Inc.</td>
            <td>Bank account aggregation</td>
            <td>Per Plaid&apos;s End User Privacy Policy</td>
          </tr>
          <tr>
            <td>Cloudflare Inc.</td>
            <td>DNS, WAF, CDN, encrypted backups (R2)</td>
            <td>Request metadata, encrypted database backups</td>
          </tr>
          <tr>
            <td>Hetzner Online GmbH</td>
            <td>Compute and storage (Ashburn, Virginia, US)</td>
            <td>Application data at rest</td>
          </tr>
          <tr>
            <td>Vercel Inc.</td>
            <td>Web hosting (withfina.com)</td>
            <td>Page view metadata; no financial data</td>
          </tr>
          <tr>
            <td>Stripe Inc.</td>
            <td>Subscription billing</td>
            <td>Email + Stripe-managed payment method</td>
          </tr>
          <tr>
            <td>Resend Inc.</td>
            <td>Transactional email (verification, password reset)</td>
            <td>Email address</td>
          </tr>
          <tr>
            <td>Google LLC (Gemini)</td>
            <td>AI categorization and chat responses</td>
            <td>Merchant text and chat message content</td>
          </tr>
          <tr>
            <td>650 Industries Inc. (Expo)</td>
            <td>Mobile push notification delivery</td>
            <td>Expo push token and notification payload</td>
          </tr>
          <tr>
            <td>Apple Inc. / Google LLC</td>
            <td>In-app purchase processing (mobile)</td>
            <td>Receipt and bundle identifier</td>
          </tr>
        </tbody>
      </table>

      <h2>4. How we protect your data</h2>
      <ul>
        <li>
          <strong>Encryption in transit</strong> — TLS 1.2 or better on every
          public endpoint, behind Cloudflare.
        </li>
        <li>
          <strong>Encryption at rest</strong> — Plaid access tokens are
          encrypted with AES-256-GCM at the application layer; the
          underlying database disk is encrypted at the volume level.
          Backups are encrypted in transit and at rest in Cloudflare R2.
        </li>
        <li>
          <strong>Network controls</strong> — our origin server accepts
          traffic only from Cloudflare&apos;s IP ranges; direct connections
          are dropped.
        </li>
        <li>
          <strong>Access controls</strong> — administrative access requires
          multi-factor authentication; SSH access uses ed25519 keys with
          root login disabled.
        </li>
        <li>
          <strong>Operator scope</strong> — Fina is currently operated by a
          single founder; only that operator has production access.
        </li>
      </ul>
      <p>
        Our full security policy is published at{" "}
        <a href="/security">withfina.com/security</a>.
      </p>

      <h2>5. Data retention</h2>
      <ul>
        <li>
          <strong>Account data</strong> — retained while your account is
          active.
        </li>
        <li>
          <strong>Plaid webhook events</strong> — retained for 30 days then
          auto-pruned.
        </li>
        <li>
          <strong>Resolved scheduled-spend records</strong> — retained for
          90 days then auto-pruned.
        </li>
        <li>
          <strong>Backups</strong> — 30 daily + 12 monthly snapshots in
          Cloudflare R2; older snapshots are expired automatically.
        </li>
        <li>
          <strong>Account deletion</strong> — when you delete your account,
          we disconnect your Plaid item via Plaid&apos;s <code>/item/remove
          </code> endpoint, then cascade-delete all data associated with
          your user record within one hour. Backups containing data from
          before deletion age out within twelve months.
        </li>
      </ul>

      <h2>6. Your choices and rights</h2>
      <ul>
        <li>
          <strong>Access and export</strong> — email{" "}
          <a href="mailto:cwsbrian@gmail.com">cwsbrian@gmail.com</a> and we
          will provide a copy of your data within 30 days.
        </li>
        <li>
          <strong>Correct or update</strong> — most fields are editable in
          the app; for anything else, contact us.
        </li>
        <li>
          <strong>Delete</strong> — use the account-deletion flow in the
          app, or email us. We honor deletion requests within 30 days.
        </li>
        <li>
          <strong>Disconnect a bank</strong> — use Plaid item disconnect in
          the app at any time. We remove the encrypted access token and
          stop fetching new transactions.
        </li>
        <li>
          <strong>Marketing email</strong> — Fina sends only transactional
          email (verification, password reset, important account notices)
          today. We do not send marketing email.
        </li>
        <li>
          <strong>California residents (CCPA)</strong> — you have the right
          to know what we collect, to delete your data, and to non-
          discrimination for exercising these rights. We do not sell your
          personal information.
        </li>
      </ul>

      <h2>7. Children</h2>
      <p>
        Fina is not directed to children under 16, and we do not knowingly
        collect data from them. If you believe a child has provided us
        information, please contact us and we will delete it.
      </p>

      <h2>8. International users</h2>
      <p>
        Fina is operated from the United States. Our servers are located in
        Ashburn, Virginia. By using the service, you understand your data
        will be processed in the US. We do not currently target users in
        the European Union or the United Kingdom; if you are located there,
        please be aware our data practices follow US standards and may
        differ from those required under the GDPR.
      </p>

      <h2>9. Changes to this policy</h2>
      <p>
        We may update this policy as the product evolves. When we make
        material changes, we will revise the &quot;Last updated&quot; date at
        the top and notify active users by email. Continued use of Fina
        after a change means you accept the updated policy.
      </p>

      <h2>10. Contact</h2>
      <p>
        Questions or requests:{" "}
        <a href="mailto:cwsbrian@gmail.com">cwsbrian@gmail.com</a>.
      </p>
    </>
  );
}
