# Fina — Information Security Policy

**Version 1.0** · Effective 2026-05-26 · Owner: Brian Choi (founder) · Next review: 2026-08-26

---

## 1. Scope

Anything that stores, processes, or transmits consumer financial data we obtain through
Plaid: the Fina API server (`api.withfina.com` on Hetzner), its Postgres database,
backups in Cloudflare R2, the web app (`withfina.com` on Vercel), and the iOS / Android
apps. Also: every third-party listed in §6.

## 2. Who's responsible

Fina is one person. Brian Choi is the security officer, engineer, operator, and privacy
officer until we hire. When that changes, this section gets rewritten and new personnel
sign an acknowledgement before getting production access.

## 3. What we worry about

The threats below drive the controls in §4. The list is reviewed quarterly and after every
incident; we drop items that no longer apply and add new ones as the product changes.

- **Plaid `access_token` leak.** Most sensitive thing we hold. AES-256-GCM at rest,
  workspace-bound AAD, never logged.
- **Account takeover.** Credential stuffing, session hijack, password reset abuse.
- **Origin server bypass.** Someone reaches the API without going through Cloudflare's
  WAF and rate-limit.
- **Webhook spoofing.** Forged Plaid / Stripe / IAP webhooks moving money or state.
- **Supply chain.** A poisoned npm package, base Docker image, or system update.
- **Operator key compromise.** SSH key, sub-processor account credentials.
- **Backup loss or tamper.** DR capability gone.
- **DDoS.** Service exhaustion (no data loss, but customer impact).
- **Common app bugs.** SQLi, XSS, IDOR, missing authz on a new route.
- **Sub-processor breach.** Out of our direct control; we minimize blast radius.

## 4. How we mitigate

### 4.1 Encryption

Plaid `access_token` is encrypted with **AES-256-GCM** at the application layer before
it touches the database — see `apps/api/src/crypto/aes-gcm.ts`. Workspace ID is bound as
AAD, so a ciphertext can't be lifted from one workspace and decrypted in another. The
underlying Hetzner Cloud volume is LUKS-encrypted at rest. Backups to Cloudflare R2 use
TLS in transit and R2 server-side encryption at rest. Pino logger redacts `accessToken`,
`access_token`, `Authorization`, and `cookie` fields, so tokens never reach logs.

Public endpoints enforce TLS 1.2+ via Cloudflare. Cloudflare → origin uses TLS with the
15-year Origin Certificate. `ufw` on the origin allows port 443 only from Cloudflare IP
ranges; direct connections are dropped. There is no path to the API that skips
Cloudflare's WAF.

### 4.2 Authentication and session

Better Auth (v1.6+) handles sign-in: email + bcrypt password, with email-OTP verification
required before the first session. Cookies are HttpOnly, Secure, SameSite=Lax, signed
with a 48-character `BETTER_AUTH_SECRET`. Sign-in and sign-up have a 5/min/IP rate limit
to slow credential stuffing. TOTP-based MFA for end users is on the roadmap via Better
Auth's `twoFactor` plugin — not shipped yet.

For the operator: SSH is ed25519 key-only with password auth and root login disabled,
fail2ban bans on brute-force. Every admin console with access to consumer data
(Cloudflare, Hetzner, Plaid, Stripe, Vercel, Resend) has MFA enabled on the operator's
account. The Coolify admin console sits behind Cloudflare Access (Zero Trust) and only
the operator's identity is whitelisted.

### 4.3 Authorization

Every authenticated route resolves `req.workspaceId` from the `X-Workspace-Id` header
and then asserts a `Membership` row exists with the appropriate role before any query
runs against workspace-owned tables. Prisma where-clauses always include `workspaceId`,
and the AES-GCM AAD binding (above) is a second layer: if a wrong-workspace ciphertext
were ever served, decryption fails.

### 4.4 Application

TypeScript strict mode. All API request bodies validated by `zod` schemas
(`libs/shared/src/schemas/*`) before any business logic runs. Prisma parameterized
queries throughout — no string concatenation against the DB. `@fastify/helmet` for
security headers. Plaid, Stripe, and IAP webhooks verify signatures before any state
change.

### 4.5 Supply chain and patching

pnpm with frozen lockfile. `pnpm audit` reviewed monthly, advisories acted on within
seven days. GitHub Dependabot alerts on. Production OS is Ubuntu 24.04 LTS with
`unattended-upgrades` applying security patches daily. Node and Postgres images are
bumped quarterly.

### 4.6 Backups

Coolify runs `pg_dump` to Cloudflare R2 at 05:00 UTC every day. We keep 30 daily and 12
monthly snapshots. Quarterly we restore the latest dump into a clean Postgres and run
the integration test suite against it — that's the only way to know backups actually
work.

## 5. How we know it's working

- **Uptime.** Better Stack pings `/health` every minute and alerts on two consecutive
  failures.
- **Logs.** Pino structured logs to stdout → Coolify, 30-day retention. Auth headers,
  cookies, and tokens redacted at the logger.
- **Edge.** Cloudflare Analytics for traffic and threat events. WAF events reviewed
  monthly.
- **Webhooks.** Plaid and Stripe webhook delivery status reviewed weekly.
- **Backups.** Coolify emails backup success/failure daily; the absence of a success
  email is itself a signal.

## 6. When something goes wrong

1. **Triage within an hour of detection.** Decide containment vs. investigation.
2. **Contain.** Suspected DB compromise → rotate `BETTER_AUTH_SECRET` (invalidates all
   sessions) and force password resets. Compromised SSH key → revoke via Hetzner rescue,
   audit `last` / `who`, generate new key. Compromised sub-processor account → rotate
   credentials, audit their access logs.
3. **Notify.** Plaid via `partner-security@plaid.com` within 24 hours if Plaid data is
   implicated. Affected users by email within 72 hours.
4. **Eradicate and recover.** Patch the root cause, restore from backup if needed.
5. **Postmortem** in `docs/incidents/YYYY-MM-DD-<slug>.md` within 7 days. Whatever the
   incident taught us goes back into this policy at the next review.

## 7. Sub-processors

Reviewed quarterly. Adding a new sub-processor that handles consumer data requires a
written reason recorded in this section's git history.

| Sub-processor | What they do | Data shared |
|---|---|---|
| Plaid Inc. | Bank aggregation (Auth, Transactions, Identity) | Per Plaid agreement |
| Cloudflare, Inc. | DNS, WAF, CDN, R2 backups | Request metadata + encrypted DB backups |
| Hetzner Online GmbH | Compute + storage (Ashburn, VA) | Application data at rest |
| Vercel Inc. | Web hosting (withfina.com) | Page metadata only, no financial data |
| Stripe, Inc. | Subscription billing | Email + Stripe-managed payment method |
| Resend Inc. | Transactional email | Email address |
| Google LLC (Gemini) | LLM categorization + chat | Merchant strings, chat messages |
| Expo (650 Industries) | Mobile push delivery | Push token, notification payload |
| Apple / Google (IAP) | iOS / Android subscription billing | Receipt + bundle ID |

We do not sell or share user data with advertisers. We do not use transaction data to
train our own models.

## 8. What we keep, and how long

| What | How it's protected | How long we keep it |
|---|---|---|
| Plaid `access_token` | AES-256-GCM (app) + LUKS (disk) | While the user keeps the bank linked |
| Email, password hash, transactions, balances | LUKS (disk) | While the account is active |
| Plaid webhook events | LUKS (disk) | 30 days, then cron purges |
| Resolved scheduled-spend rows | LUKS (disk) | 90 days, then cron purges |
| App logs | Coolify on-host | 30 days |
| Backups | TLS in transit, R2 SSE at rest | 30 daily + 12 monthly snapshots |

Account deletion cascades all user-owned rows within one hour. Backups containing
pre-deletion data expire on the schedule above (max 12 months).

## 9. Compliance posture

- **PCI DSS:** Not applicable — Stripe Checkout handles all card data; Fina servers
  never see a PAN.
- **SOC 2:** Not certified. Type I planned for year 1 if user growth warrants the cost.
- **GDPR:** Not actively targeting EU users at launch. When we expand there, data
  subject rights (Articles 15–20) get implemented.
- **CCPA:** Honored — account deletion removes all personal data within 30 days;
  privacy notice at `withfina.com/privacy` discloses categories collected.
- **Plaid End User Privacy Policy obligations:** Mirrored in our consumer-facing privacy
  policy.

## 10. Reviewing this policy

Quarterly (March, June, September, December) and after every incident. Each review is a
commit to this file. The commit message includes `policy-review:<YYYY-Q?>`. Review
covers: are the §3 threats still the right ones, are §4 controls still in place, is the
§7 sub-processor list current, and did anything in the last quarter teach us something
we should write down.
