# Fina — Information Security Policy

**Version**: 1.0
**Effective**: 2026-05-26
**Owner**: Brian Choi (Founder / Sole Operator)
**Review cadence**: Quarterly, and on any material change to architecture
or sub-processors.

> This is Fina's operationalized information security policy. It describes
> how we identify, mitigate, and monitor the risks of building a consumer
> personal-finance product that handles Plaid-sourced financial data.

---

## 1. Scope

This policy applies to:

- All systems that store, process, or transmit consumer financial data
  obtained through Plaid (the Fina API server, its Postgres database,
  and Cloudflare R2 backups).
- The Fina web application (withfina.com on Vercel) and Fina mobile
  application (Expo / EAS) which provide the consumer interface.
- All third-party sub-processors listed in § 7.
- The personnel listed in § 2.

It does NOT apply to: marketing communications, public-facing static
assets, or third-party services that do not handle consumer data.

---

## 2. Roles & responsibilities

Fina is currently a single-founder operation. The founder
(Brian Choi, cwsbrian@gmail.com) holds all of the following roles:

- **Security Officer** — owns this policy, reviews it quarterly,
  responds to security incidents.
- **Engineering** — implements and tests technical controls.
- **Operations** — manages production servers, backups, and
  sub-processor accounts.
- **Privacy Officer** — handles data subject requests and complaints.

As Fina grows, these roles will be separated and assigned to named
personnel; this policy will be revised at that time.

---

## 3. Risk identification

We identify and re-evaluate the following risks on each quarterly review
and any time architecture changes:

| # | Risk | Likelihood | Impact |
|---|---|---|---|
| R-1 | Plaid access_token leak via DB exfiltration | Low | High — attacker could read user financial data |
| R-2 | Session hijack / credential stuffing | Medium | Medium — attacker accesses one user's account |
| R-3 | Origin server exposure (bypassing Cloudflare) | Low | Medium — attacker bypasses WAF/rate-limit |
| R-4 | Sub-processor breach (Plaid, Stripe, etc.) | Low | High — out of our direct control |
| R-5 | Supply chain attack via npm dependency | Medium | High — malicious code in production |
| R-6 | Lost / compromised operator SSH key | Low | Critical — full prod access |
| R-7 | Backup tampering or loss | Low | High — DR capability lost |
| R-8 | DDoS / service exhaustion | Medium | Low — temporary outage, no data loss |
| R-9 | Insecure code (SQLi, XSS, IDOR) | Medium | High — depends on vector |
| R-10 | Webhook spoofing (Plaid / Stripe / IAP) | Low | High — fraudulent state changes |

---

## 4. Mitigation controls

### 4.1 Data protection (R-1, R-4, R-7)

- Plaid `access_token` encrypted at rest with AES-256-GCM
  (`apps/api/src/crypto/aes-gcm.ts`). Workspace ID bound as AAD; 96-bit
  random IV per encryption; ciphertext + IV stored in `bytea` columns.
- Disk encryption at the Hetzner Cloud volume layer (LUKS).
- Plaid tokens are never written to logs (`pino` redact rules).
- Daily Postgres backups to Cloudflare R2, TLS in transit + R2 SSE at
  rest. 30 daily + 12 monthly retention.

### 4.2 Authentication & session (R-2, R-6)

- Sign-in: email + bcrypt-hashed password, with email-OTP verification
  required before sign-in is allowed (`Better Auth` library, v1.6+).
- Session cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, signed by
  `BETTER_AUTH_SECRET` (48+ char random).
- Brute-force protection: 5 requests/min/IP on sign-in & sign-up routes
  via Fastify rate-limit plugin.
- Operator SSH: ed25519 public key only, no password auth, root login
  disabled, fail2ban active (3-strike, 1-hour ban).
- All third-party admin consoles (Cloudflare, Hetzner, Plaid, Stripe,
  Vercel) have MFA enabled on the operator's account.
- Coolify admin console gated behind Cloudflare Access (Zero Trust)
  requiring identity verification.

### 4.3 Network security (R-3, R-8)

- Cloudflare proxy (orange cloud) in front of all production hostnames.
- `ufw` allows only port 22 (SSH) + 443 (HTTPS, Cloudflare IP ranges
  only). Direct origin connections from non-Cloudflare IPs are dropped.
- Cloudflare WAF Managed Rules ON; Bot Fight Mode ON; OWASP rules ON.
- Cloudflare native L3/4 + L7 DDoS mitigation.
- Postgres on internal Docker bridge network, never exposed to host or
  internet.

### 4.4 Application security (R-9, R-10)

- All API request bodies validated by `zod` schemas
  (`libs/shared/src/schemas/*`).
- Prisma parameterized queries throughout; no SQL string concatenation.
- TypeScript `strict` mode + `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`.
- `@fastify/helmet` for security headers (HSTS, X-Frame-Options DENY,
  X-Content-Type-Options nosniff).
- Workspace-scoped authorization on every authenticated route:
  `req.workspaceId` resolved + Membership check before any data query.
- Plaid webhooks: JWT signature verified against Plaid JWKS before any
  state mutation.
- Stripe webhooks: signature verified with `STRIPE_WEBHOOK_SECRET`.
- IAP webhooks (Apple/Google): JWS verified against vendor public keys.

### 4.5 Supply chain (R-5)

- `pnpm` with frozen lockfile; reproducible installs.
- `pnpm audit` reviewed monthly; advisories acted on within 7 days.
- GitHub Dependabot alerts enabled on the repository.
- Production OS auto-patched via `unattended-upgrades`.

### 4.6 Backups & disaster recovery (R-7)

- Daily `pg_dump` → Cloudflare R2 at 05:00 UTC.
- Retention: 30 daily + 12 monthly.
- Quarterly restore drill — most recent backup restored into a clean
  Postgres, integration test suite executed, row counts asserted.
- RTO: < 2 hours. RPO: < 24 hours.

---

## 5. Monitoring

### 5.1 Continuous monitoring

- **Uptime**: Better Stack pings `https://api.withfina.com/health` every
  minute; alerts operator via email + SMS on 2 consecutive failures.
- **Edge metrics**: Cloudflare Analytics — request volume, threat
  events, country distribution.
- **Application logs**: Structured JSON via `pino`, aggregated by
  Coolify with 30-day on-host retention; redacts auth headers,
  cookies, and Plaid tokens.
- **Authentication events**: SSH logins, sudo invocations, fail2ban
  bans logged to systemd journal.

### 5.2 Reactive monitoring

- **Plaid dashboard**: Webhook delivery failures reviewed weekly.
- **Stripe dashboard**: Failed payments + disputed charges reviewed
  weekly.
- **Cloudflare WAF events**: Reviewed monthly for emerging attack
  patterns.
- **Backup integrity**: Coolify reports backup success/failure to
  operator email daily.

---

## 6. Incident response

### 6.1 Detection sources

- Better Stack uptime alert.
- User report via `cwsbrian@gmail.com` (will be `security@withfina.com`
  once that mailbox is provisioned).
- Plaid security notification (`partner-security@plaid.com`).
- Cloudflare WAF threat spike alert.

### 6.2 Response runbook

1. **Triage** (within 1 hour of detection): assess scope, decide
   containment vs. investigation.
2. **Contain**:
   - Suspected DB breach: rotate `BETTER_AUTH_SECRET` (invalidates
     sessions) + force password resets.
   - Compromised SSH key: revoke via Hetzner console rescue mode,
     generate new key, audit `last` / `who`.
   - Compromised sub-processor account: rotate credentials + audit
     access logs.
3. **Notify**:
   - Plaid via `partner-security@plaid.com` within 24h if Plaid data
     is implicated.
   - Affected users via email within 72h (CCPA timing).
   - Other affected sub-processors as required by their agreements.
4. **Eradicate**: identify root cause, patch, deploy.
5. **Recover**: restore from backup if needed.
6. **Postmortem**: documented in `docs/incidents/YYYY-MM-DD-<slug>.md`
   within 7 days. Reviewed quarterly to update this policy.

---

## 7. Sub-processors

Sub-processors handling consumer financial data or PII:

| Sub-processor | Purpose | Data shared | Agreement |
|---|---|---|---|
| Plaid Inc. | Bank aggregation (Auth, Transactions, Identity) | Bank account linkages, transactions, balances | Plaid Production Agreement |
| Cloudflare, Inc. | DNS, WAF, CDN, R2 backups | Request metadata + encrypted DB backups | Standard ToS |
| Hetzner Online GmbH | Compute + storage (Ashburn, VA, US) | Application data at rest | Standard ToS + DPA |
| Vercel Inc. | Web hosting (marketing + signup) | Email addresses (waitlist) — no financial data | Standard ToS |
| Stripe, Inc. | Subscription billing | Email + Stripe-managed payment method | Stripe Services Agreement |
| Resend, Inc. | Transactional email | Email address | Standard ToS |
| Google LLC (Gemini) | LLM categorization + chat | Merchant strings + chat messages | Google AI Studio ToS |
| 650 Industries Inc. (Expo) | Mobile push delivery | Expo push token + notification payload | Expo ToS |
| Apple Inc. | iOS IAP | Receipt + bundle ID | Apple Developer Agreement |
| Google LLC (Play Billing) | Android IAP | Subscription notification payload | Play Developer Agreement |

Sub-processor list reviewed quarterly. New sub-processors require
documented justification before adoption.

---

## 8. Data classification & handling

| Category | Examples | Storage | Encryption | Retention |
|---|---|---|---|---|
| Restricted | Plaid access_token | Postgres (bytea) | AES-256-GCM (app) + LUKS (disk) | While account active |
| Sensitive | Email, password hash, bank account/txn data | Postgres | LUKS (disk) | While account active |
| Internal | App logs, telemetry | stdout → Coolify | LUKS | 30 days |
| Public | Marketing site, /security, /privacy | Vercel static | TLS in transit | N/A |

Account deletion cascades remove all Restricted + Sensitive rows
within 1 hour of request. Backups containing the user's data age out
per backup retention schedule (max 12 months).

---

## 9. Personnel security

- **Headcount with production access**: 1 (founder).
- **Background checks**: Not applicable at current scale.
- **Onboarding/offboarding**: N/A until first hire.
- **Security training**: The founder maintains awareness via OWASP Top
  10, NIST guidelines, and Plaid security guidance.
- **First hire control**: New personnel with production access will
  require this policy review + signed acknowledgement before access
  grant.

---

## 10. Change management

- Source control: GitHub (private repo). All changes via pull request
  on feature branches; squash-merged to `main`.
- Code review: For solo development, self-review against
  `docs/PRODUCTION-READY.md` checklist before merge.
- Deployment: Coolify auto-deploys `main` to production; previous
  deployment is one-click rollback.
- Schema migrations: Prisma migrations versioned in
  `apps/api/prisma/migrations/`; tested against a clean DB in CI before
  merge.

---

## 11. Compliance posture

- **PCI DSS**: Not applicable — Stripe Checkout handles all PAN data.
- **SOC 2**: Not certified. Type I planned for year 1 if user base
  warrants.
- **GDPR**: Not actively targeting EU users at launch. If/when
  expanding, data subject rights (Articles 15-20) will be implemented.
- **CCPA**: Honored — account deletion removes all personal data
  within 30 days; privacy notice discloses categories collected.
- **Plaid End User Privacy Policy obligations**: Mirrored in Fina's
  privacy policy (withfina.com/privacy).

---

## 12. Policy review

This policy is reviewed:

- **Quarterly** (March, June, September, December) by the founder.
- **On material change** to architecture, sub-processors, or scale.
- **After every security incident** as part of the postmortem.

Each review is recorded in this document's git history. The most recent
review's commit message includes `policy-review:<YYYY-Q?>`.

---

**Approved by**: Brian Choi, Founder
**Date**: 2026-05-26
**Next review**: 2026-08-26
