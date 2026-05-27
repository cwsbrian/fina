import styles from "../legal.module.css";

export const metadata = {
  title: "Terms of Service · Fina",
  description: "The terms that govern your use of Fina.",
};

export default function Terms() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className={styles.meta}>Last updated: May 26, 2026</p>

      <p>
        These Terms of Service (&quot;Terms&quot;) govern your access to and
        use of Fina, a personal finance application operated by Brian Choi
        (&quot;we&quot;, &quot;us&quot;). By creating an account or using
        Fina, you agree to these Terms. If you do not agree, do not use the
        service.
      </p>

      <h2>1. The service</h2>
      <p>
        Fina helps you understand your money by aggregating your bank
        accounts (through Plaid), categorizing transactions, tracking
        budgets and goals, and answering questions about your finances. We
        provide the service &quot;as is&quot; and continually improve it.
      </p>
      <p>
        Fina is <strong>not</strong> a bank, a broker-dealer, an investment
        advisor, or a tax professional. Information shown in Fina is for
        personal informational purposes only and is not financial,
        investment, legal, or tax advice.
      </p>

      <h2>2. Eligibility and account</h2>
      <ul>
        <li>You must be at least 16 years old to create a Fina account.</li>
        <li>You must provide accurate information at sign-up and keep it
          current.</li>
        <li>You are responsible for safeguarding your password and any
          activity under your account.</li>
        <li>One person per account. You may not share credentials.</li>
      </ul>

      <h2>3. Bank account connections (Plaid)</h2>
      <p>
        Connecting a bank account uses Plaid, an authorized financial-data
        provider. By connecting an account, you agree to{" "}
        <a href="https://plaid.com/legal/#end-user-privacy-policy" target="_blank" rel="noreferrer">
          Plaid&apos;s End User Privacy Policy
        </a>{" "}
        and grant Fina permission to access the account information you
        authorize through Plaid Link. You can disconnect a bank at any
        time in the app.
      </p>

      <h2>4. Subscriptions and payment</h2>
      <ul>
        <li>Fina offers a free trial. Some features require a paid
          subscription (Lite or Pro).</li>
        <li>Web subscriptions are billed via Stripe. iOS and Android
          subscriptions are billed via Apple App Store and Google Play
          respectively.</li>
        <li>Subscriptions renew automatically until cancelled. You can
          cancel at any time through Stripe&apos;s billing portal or your
          mobile app store; cancellation takes effect at the end of the
          current billing period.</li>
        <li>We may change pricing with at least 14 days&apos; notice; the
          new price applies to your next renewal.</li>
        <li>Refunds: we follow the policy of the platform that processed
          the payment (Stripe, Apple, or Google). Contact us if you believe
          you were charged in error.</li>
      </ul>

      <h2>5. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Reverse-engineer or attempt to extract source code from the
          service except as permitted by law.</li>
        <li>Probe, scan, or test the vulnerability of any Fina system
          without written permission (responsible disclosure to{" "}
          <a href="mailto:cwsbrian@gmail.com">cwsbrian@gmail.com</a> is
          welcomed).</li>
        <li>Use Fina to violate any law or third party&apos;s rights.</li>
        <li>Access accounts or data you are not authorized to access.</li>
        <li>Interfere with the operation of the service or impose
          unreasonable load.</li>
      </ul>

      <h2>6. Your content</h2>
      <p>
        You retain ownership of the data you put into Fina (categories,
        budgets, goals, notes, chat messages). You grant us a limited
        license to process that data solely to operate and improve the
        service for you.
      </p>

      <h2>7. Termination</h2>
      <ul>
        <li>You may delete your account at any time from the app, which
          removes your data per the{" "}
          <a href="/privacy">Privacy Policy</a>.</li>
        <li>We may suspend or terminate accounts that violate these Terms
          or that pose a security risk; where reasonable, we will give
          notice and an opportunity to cure.</li>
      </ul>

      <h2>8. Disclaimers</h2>
      <p>
        Fina is provided &quot;as is&quot; and &quot;as available&quot;.
        To the maximum extent permitted by law, we disclaim all warranties,
        express or implied, including merchantability, fitness for a
        particular purpose, and non-infringement. We do not warrant that
        Fina will be uninterrupted, error-free, or that the data shown is
        accurate or complete — transaction data flows from your bank
        through Plaid and may be delayed or incorrect.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, our aggregate liability for
        all claims arising out of or relating to these Terms or the service
        is limited to the greater of (a) the amount you paid us for the
        service in the twelve months preceding the claim, or (b) one
        hundred US dollars (USD 100). We are not liable for indirect,
        incidental, consequential, special, or punitive damages.
      </p>

      <h2>10. Governing law and disputes</h2>
      <p>
        These Terms are governed by the laws of the Province of Ontario,
        Canada, without regard to conflict-of-laws principles. You and we
        agree to attempt to resolve any dispute informally first by
        contacting <a href="mailto:cwsbrian@gmail.com">cwsbrian@gmail.com</a>.
        Any unresolved dispute will be brought exclusively in the courts
        located in Toronto, Ontario, Canada, unless otherwise required by
        applicable consumer law.
      </p>

      <h2>11. Changes</h2>
      <p>
        We may update these Terms as the service evolves. Material changes
        will be announced by email and the &quot;Last updated&quot; date
        will be revised. Continued use after a change means you accept the
        updated Terms.
      </p>

      <h2>12. Contact</h2>
      <p>
        <a href="mailto:cwsbrian@gmail.com">cwsbrian@gmail.com</a>
      </p>
    </>
  );
}
