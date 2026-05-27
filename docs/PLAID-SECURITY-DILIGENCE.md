# Plaid Security Diligence — answer reference

> Plaid 의 production access 신청 시 제출하는 security questionnaire 답변 정리.
> 실제 Fina 구현 기준 — 거짓 없이, 부풀리지 않고 정확히 작성.
> 모르는 항목은 "Not applicable" / "Not yet implemented" 로 솔직히.

**작성일**: 2026-05-26
**대상 product**: Fina — personal finance app for individuals
**대상 user base**: consumer (B2C), <10k users at launch
**Plaid products used**: Auth, Transactions, Identity

---

## A. Data security

### A.1 Encryption at rest

| 항목 | 답변 |
|---|---|
| Algorithm | **AES-256-GCM** (industry standard authenticated encryption) |
| Key length | 256 bits (32 bytes) |
| What's encrypted | Plaid `access_token` for every linked item, stored in `plaid_item.accessTokenCipher` (bytea) + `accessTokenIv` (bytea, 96-bit IV per item) |
| AAD (Additional Authenticated Data) | Workspace ID — binds ciphertext to its owning workspace; prevents cross-workspace cipher substitution |
| Implementation | Node.js `node:crypto` `createCipheriv("aes-256-gcm", ...)` — see `apps/api/src/crypto/aes-gcm.ts` |
| Database column types | `bytea` (raw bytes) — no base64 overhead, no string storage |
| Other PII at rest | Email, name, transactions, balances — stored unencrypted in Postgres (protected by DB-level access control + disk encryption at the host level) |
| Disk encryption | Hetzner Cloud volumes are LUKS-encrypted at rest by default |
| Backup encryption | Daily Postgres dump → Cloudflare R2 → R2 server-side encryption (SSE) automatic |

### A.2 Encryption in transit

| 항목 | 답변 |
|---|---|
| Public-facing endpoints | TLS 1.2+ enforced — Cloudflare in front of api.withfina.com, no plain HTTP. |
| Cloudflare → origin | mTLS via Cloudflare Origin Certificate (15-year, *.withfina.com) + Cloudflare "Full (strict)" SSL mode |
| Origin firewall | ufw allows port 443 only from Cloudflare IP ranges (https://www.cloudflare.com/ips/) — direct origin connections are dropped |
| Database (internal) | API ↔ Postgres on the same Coolify-managed Docker network, never crosses host boundary |
| Plaid API client → Plaid | TLS 1.2+ via official `plaid` npm SDK (^42) |

### A.3 Key management

| 항목 | 답변 |
|---|---|
| Where is the encryption key stored? | `ENCRYPTION_KEY` env variable — provisioned via Coolify's encrypted secrets store, written to the application container at deploy time. Not in source control, not in logs. |
| Key generation | `openssl rand -base64 32` — Linux kernel CSPRNG |
| Key rotation policy | Not currently rotated. Rotation would require re-encrypting every `plaid_item` row, currently a manual ops task. Documented internally as a limitation. |
| Access to key material | Only the production server's running container. The single founder/operator has Coolify console access; no other personnel. |
| Key backup | Stored in 1Password (encrypted personal vault, MFA-protected) by operator |

### A.4 Token handling

| 항목 | 답변 |
|---|---|
| Plaid access_token lifecycle | Received from `/link/token/exchange` → immediately encrypted → encrypted bytes written to DB → raw token discarded from memory after the route handler returns |
| Token in logs | **Never** — `pino` logger has redact rules for `accessToken`, `access_token`, `Authorization`, `cookie` keys |
| Token in error messages | Never echoed back. Errors reference Plaid `item_id` only |
| Public_token | Used once for `/link/token/exchange`, never persisted |

---

## B. Access control

### B.1 Application authentication (end users)

| 항목 | 답변 |
|---|---|
| Auth library | **Better Auth** (v1.6+) — actively maintained, zod-validated, session-cookie based |
| Email + password | bcrypt-hashed via Better Auth (default cost factor) |
| Email verification | Required before sign-in. 6-digit OTP via Resend, 10-minute expiry |
| Session cookies | HttpOnly + Secure + SameSite=Lax + signed by `BETTER_AUTH_SECRET` (48+ char random) |
| MFA | Not currently offered to end users. Planned: TOTP via Better Auth's `twoFactor` plugin. |
| Social login | Google OAuth (optional; not enabled at launch) |
| Password reset | Single-use signed link, 1-hour expiry |
| Brute-force protection | Fastify rate-limit plugin: **5 requests / minute / IP** on `/api/auth/sign-in/*` (strict) + `/api/auth/sign-up/*`; 30/min/IP on other auth routes |

### B.2 Operator / admin access

| 항목 | 답변 |
|---|---|
| Production server SSH | Single operator (founder) — key-only auth, password auth disabled, root login disabled, fail2ban active |
| SSH key type | ed25519 |
| Coolify admin console | Behind Cloudflare Access (Zero Trust) — only operator's email is whitelisted; requires Cloudflare login + email OTP before reaching the Coolify login page |
| Database direct access | Only via `docker exec` into the Postgres container on the host — requires SSH access first |
| Plaid dashboard access | Single operator account |
| Stripe dashboard | Single operator account, hardware MFA (security key) |
| Personnel count with prod access | **1** (sole founder/operator) |

### B.3 Internal authorization

| 항목 | 답변 |
|---|---|
| Multi-tenancy model | User → Workspace (with role) — every read/write is workspace-scoped via `X-Workspace-Id` header + membership check |
| Workspace role enforcement | Every authenticated route resolves `req.workspaceId` then asserts `Membership` record exists with appropriate role (owner / editor / viewer) before any DB query touches workspace-owned tables |
| Cross-workspace access | Prevented at the query layer (every Prisma where-clause includes `workspaceId`) AND by AES-GCM AAD binding (decrypt fails if a wrong-workspace ciphertext is presented) |

---

## C. Network security

| 항목 | 답변 |
|---|---|
| Host | Hetzner Cloud CX23 (Ashburn, VA) |
| Public surface | Only ports 22 (SSH, key-only) + 443 (HTTPS, Cloudflare IPs only) via ufw |
| DDoS protection | Cloudflare network — automatic L3/4 + L7 protection on all proxied hostnames |
| WAF | Cloudflare WAF — Managed Rules ON, Bot Fight Mode ON, OWASP rules ON |
| Rate limiting | Cloudflare rate limiting rules (login + signup) + application-level Fastify rate-limit |
| TLS termination | Cloudflare edge (TLS 1.2+, modern ciphers); re-encrypted to origin with Origin Cert |
| Network segmentation | Postgres container only reachable via internal Docker bridge network, not exposed to host or internet |
| IDS / fail2ban | fail2ban monitors `auth.log` for SSH brute-force, bans IPs for 1h after 3 failures |
| OS hardening | Ubuntu 24.04 LTS + `unattended-upgrades` (automatic security patches) |

---

## D. Application security

| 항목 | 답변 |
|---|---|
| Language / framework | TypeScript (strict mode) + Fastify 5 (helmet for security headers) + Prisma 5 (parameterized queries) |
| Dependency management | pnpm with lockfile; Dependabot disabled (manual review preferred); `pnpm audit` checked monthly |
| SQL injection | Eliminated by design — Prisma uses parameterized queries exclusively; no raw SQL string concatenation. The two `prisma.$queryRaw` use sites pass tagged templates (also parameterized) |
| XSS | Next.js App Router auto-escapes JSX; no `dangerouslySetInnerHTML` for user input |
| CSRF | SameSite=Lax cookies + CORS origin allowlist (`env.WEB_APP_URL` only) |
| Input validation | All API request bodies validated through `zod` schemas (`@fina/shared/schemas/*`) before reaching service code |
| Security headers | `@fastify/helmet` registered: HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin |
| Secrets in code | Pre-commit hook blocks `re_`, `sk_live_`, `whsec_`, `psql://` patterns; .env.* in `.gitignore` |
| Vulnerability disclosure | `security@withfina.com` (planned) — responsible disclosure policy in `/security.txt` |

---

## E. Data handling

### E.1 Data collected

| Category | Examples | Sensitive? |
|---|---|---|
| Identity | Email, name | PII |
| Financial — via Plaid | Account balances, transactions, account/institution metadata | High |
| App data | Categories, budgets, goals, recurring expenses (user-defined) | Low |
| Telemetry | Cloudflare access logs (IP + UA), pino app logs | Low |

### E.2 Retention

| Data | Retention |
|---|---|
| Active user data | Indefinite while account exists |
| Plaid webhook events | 30 days (auto-cleaned by cron job, `CRON_EVENT_TTL_DAYS`) |
| Resolved ScheduledSpend rows | 90 days |
| Account deletion | User-initiated deletion → cascade delete via Prisma `onDelete: Cascade`; Plaid item disconnected via `/item/remove` first, then DB rows purged; backups containing the user's data age out per backup retention (30 daily + 12 monthly) |
| Backups | 30 daily snapshots + 12 monthly snapshots in R2 |

### E.3 Sharing & sub-processors

| Sub-processor | Purpose | Data shared |
|---|---|---|
| Plaid Inc. | Bank account aggregation | Per Plaid agreement |
| Cloudflare | DNS, WAF, CDN | Request metadata (IP, UA, URL) |
| Hetzner Online GmbH | Compute + storage | Application data at rest |
| Vercel Inc. | Web hosting (marketing + signup) | No production financial data — Vercel serves static pages + signup endpoint; the API is on Hetzner |
| Stripe Inc. | Subscription billing | Email + payment method (handled entirely by Stripe Checkout — Fina never sees PAN) |
| Resend (Resend Inc.) | Transactional email | Email address |
| Google (Gemini) | LLM for transaction categorization + chat assistant | Transaction merchant strings + chat messages |
| Expo (650 Industries) | Mobile push notification | Expo push tokens + notification payload (no financial values in payload — only counts/notification copy) |
| Apple / Google | IAP processing (mobile) | Receipt + bundle ID |

We do **not** sell or share user data with advertisers. We do **not** use user transaction data for ML training.

### E.4 PII minimization

- Plaid access_token never logged.
- Transaction amounts shown only to the owning user (workspace-scoped).
- Push notifications use generic copy ("Large charge detected on Chase account") — no exact amount, no merchant name in lock-screen text.

---

## F. Compliance

| Standard | Status |
|---|---|
| SOC 2 | **Not certified.** Single-founder startup pre-launch. Plan to pursue Type I in year 1 if user base warrants. |
| ISO 27001 | Not certified. |
| PCI DSS | Not applicable — Stripe Checkout handles all PAN data, Fina servers never receive credit card numbers. |
| GDPR | EU users not actively targeted at launch (US + Canada only). If/when expanding to EU, data subject rights (access, deletion, portability) will be implemented per Article 15-20. |
| CCPA | Honored: account deletion endpoint removes all personal data within 30 days. Privacy policy discloses categories collected. |

---

## G. Operational security

### G.1 Logging & monitoring

| 항목 | 답변 |
|---|---|
| App logs | Structured JSON via pino; redacts auth headers, cookies, Plaid tokens |
| Where stored | stdout → Coolify log aggregation (30-day retention on the host) |
| Edge logs | Cloudflare access logs (24-hour retention on free tier) |
| Uptime monitoring | Better Stack — `https://api.withfina.com/health` 1-min ping, alerts to operator email + SMS |
| Error tracking | Console errors propagate to Coolify logs. Sentry integration planned post-launch. |
| Security event alerting | fail2ban → systemd journal; ssh sudo events → journald |

### G.2 Incident response

| Scenario | Response |
|---|---|
| API down | Better Stack pings every minute, alerts operator. Roll back to previous Coolify deploy (1 click) if recent change is the cause. |
| Suspected data breach | (1) Rotate `BETTER_AUTH_SECRET` (invalidates all sessions). (2) Force password reset for affected users. (3) Notify Plaid via partner-security@plaid.com within 24h. (4) Notify affected users within 72h per CCPA. (5) Postmortem in `docs/incidents/`. |
| Lost ENCRYPTION_KEY | Recovery from 1Password backup. If both lost: all plaid_item rows become unrecoverable; users must re-link via Plaid Link. No financial data is lost (transactions are stored in plaintext); only the ability to fetch new transactions via Plaid is lost until re-link. |
| Compromised SSH key | Revoke key from `~/.ssh/authorized_keys` via Hetzner Cloud console (Rescue mode), generate new key, audit `last`/`who` output for unauthorized access. |
| DDoS | Cloudflare auto-mitigation. Manually escalate to "Under Attack" mode if needed. |

### G.3 Backup & DR

| 항목 | 답변 |
|---|---|
| Frequency | Daily pg_dump → Cloudflare R2 (`fina-backups` bucket) at 05:00 UTC |
| Retention | 30 daily + 12 monthly |
| Encryption | TLS in transit + R2 SSE at rest |
| Restore drill | Performed quarterly on staging — restore latest dump into clean Postgres, run integration test suite, assert row counts. |
| RTO | <2 hours (provision fresh server + restore dump) |
| RPO | <24 hours (daily backup cadence) |
| Off-site | R2 is by definition off-host (different provider — Cloudflare); cross-region replication TBD. |

### G.4 Patching

| 항목 | 답변 |
|---|---|
| OS | Ubuntu 24.04 LTS + `unattended-upgrades` daily |
| Node.js | LTS (v22), updated quarterly via Dockerfile bump |
| App dependencies | `pnpm update` reviewed monthly; security advisories acted on within 7 days |
| Postgres | Coolify-managed image — bumped on Postgres minor releases |

### G.5 Personnel

| 항목 | 답변 |
|---|---|
| Headcount with prod access | 1 (founder/operator) |
| Background check | Self-employed founder; no third-party employees at this stage |
| Onboarding/offboarding | N/A (single founder) |
| Security training | Founder has prior software engineering experience including security practices; reviews OWASP Top 10, NIST guidelines. |

---

## H. Plaid-specific obligations

| 항목 | 답변 |
|---|---|
| Read Plaid's End User Privacy Policy obligations | Yes, will mirror in Fina privacy policy |
| Display Plaid disclosure on Link launch | Yes — `react-plaid-link` shows Plaid's standard disclosure UI |
| User consent before fetching transactions | Yes — Plaid Link flow shows account selection + consent before token exchange |
| Allow user to disconnect | Yes — `POST /plaid/items/:id/disconnect` calls Plaid `/item/remove`, then deletes encrypted token + cached transactions |
| Webhook URL | `https://api.withfina.com/plaid/webhook` (HTTPS-only, Cloudflare-fronted) |
| Webhook signature verification | Yes — every webhook validates Plaid's JWT signature against fetched JWKS before processing |
| Honoring `ITEM_LOGIN_REQUIRED` / `NEW_ACCOUNTS_AVAILABLE` / `PENDING_EXPIRATION` | Yes — handled in `apps/api/src/plaid/webhook-item.ts`; surfaces re-auth prompt to user |

---

## Submission tips

1. **Honesty wins.** Plaid security team has seen every shortcut. Hand-wave less, admit "planned, not yet implemented" more.
2. **Attach the architecture diagram** from `PRODUCTION-READY.md` § 0.
3. **Reference specific code paths** (e.g., `apps/api/src/crypto/aes-gcm.ts`) when asked "how do you encrypt access tokens" — shows engineering rigor.
4. **Don't claim SOC 2 you don't have.** Lying disqualifies you.
5. Submit, wait. Plaid typically replies in 3-5 business days with follow-up questions.

---

## After Plaid approval

- Switch `PLAID_ENV` from `development` → `production`
- Rotate `PLAID_SECRET` to the production value
- Update Plaid dashboard webhook URL to `https://api.withfina.com/plaid/webhook`
- Smoke test with one personal bank account before announcing
