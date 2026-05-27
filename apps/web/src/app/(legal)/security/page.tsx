import styles from "../legal.module.css";

export const metadata = {
  title: "Security · Fina",
  description: "How Fina secures consumer financial data.",
};

export default function Security() {
  return (
    <>
      <h1>Security at Fina</h1>
      <p className={styles.meta}>Last updated: May 26, 2026</p>

      <p>
        Fina handles consumer financial data through Plaid. Protecting that
        data is the most important thing we do. This page summarizes the
        security practices that govern Fina&apos;s production systems. Our
        complete information security policy is maintained in our private
        engineering repository and is reviewed quarterly.
      </p>

      <h2>Encryption</h2>
      <ul>
        <li>
          <strong>At rest</strong> — Plaid access tokens are encrypted with
          AES-256-GCM at the application layer, with the owning workspace
          ID bound as Additional Authenticated Data. The underlying database
          volume is encrypted at the host level.
        </li>
        <li>
          <strong>In transit</strong> — All public endpoints enforce TLS 1.2
          or better via Cloudflare. The origin server accepts traffic only
          from Cloudflare&apos;s IP ranges; direct connections are dropped.
        </li>
        <li>
          <strong>Backups</strong> — Daily PostgreSQL backups are encrypted
          in transit and at rest in Cloudflare R2 (30 daily + 12 monthly
          snapshots).
        </li>
      </ul>

      <h2>Access control</h2>
      <ul>
        <li>
          <strong>Operator access</strong> — SSH to the production server
          uses ed25519 keys only; password authentication and root login
          are disabled.
        </li>
        <li>
          <strong>Admin consoles</strong> — Multi-factor authentication is
          enabled on every third-party admin console that touches consumer
          data (Cloudflare, Hetzner, Plaid, Stripe, Vercel).
        </li>
        <li>
          <strong>Infrastructure admin</strong> — Our Coolify deployment
          console is gated behind Cloudflare Access (Zero Trust); only the
          operator&apos;s identity is whitelisted.
        </li>
        <li>
          <strong>Application authorization</strong> — Every authenticated
          API request is scoped to the user&apos;s workspace; cross-workspace
          access is impossible at the query layer.
        </li>
      </ul>

      <h2>Network and infrastructure</h2>
      <ul>
        <li>Cloudflare WAF with Managed Rules and Bot Fight Mode.</li>
        <li>Cloudflare DDoS protection at L3/4 and L7.</li>
        <li>
          <code>ufw</code> firewall allows only port 22 (SSH) and port 443
          from Cloudflare IPs; everything else is dropped.
        </li>
        <li>
          <code>fail2ban</code> bans SSH brute-force IPs after three
          failures.
        </li>
        <li>Automatic OS security patches via <code>unattended-upgrades</code>.</li>
      </ul>

      <h2>Application security</h2>
      <ul>
        <li>TypeScript strict mode end to end.</li>
        <li>
          All API request bodies validated with <code>zod</code> schemas
          before any business logic runs.
        </li>
        <li>
          Prisma parameterized queries throughout — no SQL string
          concatenation.
        </li>
        <li>
          Plaid webhooks: JWT signatures verified against Plaid&apos;s JWKS
          before any state change.
        </li>
        <li>
          Stripe webhooks: signatures verified with the configured webhook
          secret.
        </li>
        <li>Security headers (HSTS, X-Frame-Options, X-Content-Type-Options) via Helmet.</li>
      </ul>

      <h2>Monitoring and incident response</h2>
      <ul>
        <li>
          Uptime: Better Stack pings <code>/health</code> every minute and
          alerts the operator on consecutive failures.
        </li>
        <li>
          Application logs aggregate to Coolify on the host with a 30-day
          retention window; auth headers, cookies, and Plaid tokens are
          redacted at the logger level.
        </li>
        <li>
          Edge logs and threat events are reviewed via Cloudflare Analytics.
        </li>
        <li>
          Incident response runbook covers triage, containment,
          notification (including notice to Plaid within 24 hours where
          Plaid data is implicated), eradication, recovery, and
          postmortem.
        </li>
        <li>
          Quarterly restore drill — the latest backup is restored into a
          clean PostgreSQL and verified against the integration test suite.
        </li>
      </ul>

      <h2>Responsible disclosure</h2>
      <p>
        If you believe you have found a security vulnerability in Fina,
        please email{" "}
        <a href="mailto:cwsbrian@gmail.com">cwsbrian@gmail.com</a> with
        details and a clear reproduction. We will acknowledge within 72
        hours, work with you on a fix, and credit you publicly with your
        permission once a fix is shipped.
      </p>
      <p>
        Please do not access data that is not your own, perform denial-of-
        service tests, or run automated scanners against our production
        infrastructure without written permission.
      </p>

      <h2>Compliance posture</h2>
      <p>
        Fina is a pre-launch, single-founder operation. We do not currently
        hold SOC 2, ISO 27001, or PCI DSS certifications. PCI DSS does not
        apply because Stripe Checkout handles all card data; Fina servers
        never see credit-card numbers. We plan to pursue SOC 2 Type I
        within the first year of meaningful user growth.
      </p>

      <h2>Sub-processors</h2>
      <p>
        The full list of sub-processors that handle consumer data is
        published in our <a href="/privacy">Privacy Policy</a>.
      </p>
    </>
  );
}
