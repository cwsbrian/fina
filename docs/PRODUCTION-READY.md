# Production Ready — Fina launch checklist

> 한 페이지 마스터 checklist. 자세한 step은 `DEPLOY.md` (서버 셋업) +
> `LAUNCH.md` (앱 출시) 참고. 이 문서는 **상태 + 다음 행동**만 기록.

**도메인**: `withfina.com` (web, Vercel) + `api.withfina.com` (API, Hetzner)
**Target launch**: TBD
**Last updated**: 2026-05-26

---

## 0. 아키텍처

```
                  ┌─────────────────────────────────────────┐
                  │            Cloudflare (DNS + WAF)        │
                  └────────────┬───────────────┬────────────┘
              proxy OFF        │               │ proxy ON
                               ▼               ▼
                      ┌────────────────┐ ┌──────────────────┐
                      │   Vercel       │ │  Hetzner CX23    │
                      │   withfina.com │ │  Ashburn         │
                      │   Next.js 14   │ │  api.withfina.com│
                      │   (waitlist +  │ │  Coolify +       │
                      │    app)        │ │  Fastify +       │
                      └────────────────┘ │  Postgres        │
                                         └──────┬───────────┘
                                                │
                                                ▼
                                       ┌─────────────────┐
                                       │  Cloudflare R2  │
                                       │  daily backup   │
                                       └─────────────────┘
```

**비용 추정 (월)**: $5 Hetzner + $0 Vercel hobby + $0 Cloudflare free
+ <$1 R2 = **~$6/월** (Plaid/Stripe/Resend 등 외부 서비스 별도)

---

## 1. 현재 상태

### ✅ 완료된 것

- [x] Cloudflare zone (`withfina.com`)
- [x] Origin Certificate 발급 (`*.withfina.com` + `withfina.com`)
- [x] Google Analytics `G-FGTLC7PSLB` 설치 (`apps/web/src/app/layout.tsx`,
      production-only)
- [x] Vercel 배포 (web)
- [x] `NEXT_PUBLIC_API_URL=https://api.withfina.com` Vercel 환경 변수
- [x] `apps/api/Dockerfile.prod` (bookworm-slim, tini, 비-root,
      `/health` HEALTHCHECK)
- [x] `apps/api/.env.production.example` 템플릿
- [x] `.dockerignore`
- [x] CORS + Better Auth trustedOrigins 프로덕션 차단 버그 수정
      (`env.WEB_APP_URL` 사용)
- [x] 코드/문서 도메인 `fina.app` → `withfina.com`

### 🟡 진행 중 / 대기

- [ ] Hetzner CX23 Ashburn 주문
- [ ] SSH key 결정 (기존 vs 신규)
- [ ] Plaid production access 신청 ← **1~2주 소요**
- [ ] Resend domain verification

---

## 2. 외부 서비스 셋업 (병렬 진행)

가장 오래 걸리는 것부터:

| # | 서비스 | 작업 | 산출물 (.env 채울 값) | 소요 |
|---|---|---|---|---|
| 1 | **Plaid** | Dashboard → Production access 신청 + ID/Secret 받기 | `PLAID_CLIENT_ID`, `PLAID_SECRET` | **1~2주** |
| 2 | **Resend** | Domains → `withfina.com` 추가 → Cloudflare DNS TXT/CNAME 추가 → verify | `RESEND_API_KEY` (re_…) | ~1h |
| 3 | **Stripe** | Activate live mode → API keys + webhook secret 생성 → Lite/Pro price 생성 | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_LITE_MONTHLY`, `STRIPE_PRICE_PRO_MONTHLY` | 즉시 |
| 4 | **Gemini** | Google AI Studio → API key (production quota 확인) | `GEMINI_API_KEY` | 즉시 |
| 5 | **Cloudflare R2** | Dashboard → R2 → bucket `fina-backups` 생성 + API token | R2 access key id/secret, bucket name | 10분 |
| 6 | **Expo / EAS** | `eas init` 이미 done → access token 발급 (push rate limit ↑) | `EXPO_ACCESS_TOKEN` | 10분 |
| 7 | **Apple IAP** | App Store Connect → ASC API key (.p8) — 모바일 launch 전까지 | `APPLE_*` group | 30분 |
| 8 | **Google IAP** | Play Console → service account JSON — 모바일 launch 전까지 | `GOOGLE_*` group | 30분 |

### 🔑 시크릿 생성 명령

```bash
# BETTER_AUTH_SECRET (32+ chars)
openssl rand -base64 48 | tr -d '=+/' | cut -c1-48

# ENCRYPTION_KEY (32 bytes base64)
openssl rand -base64 32
```

`ENCRYPTION_KEY`는 한 번 정하면 **절대 회전 금지** (Plaid access_token
재암호화 작업 없이는). 안전한 곳 (1Password 등) 백업.

---

## 3. 서버 셋업 (DEPLOY.md 따라가는 순서)

### 3.1 주문

- Hetzner Cloud → Ashburn → CX23 (Intel, 2 vCPU / 4 GB / 40 GB / 20 TB)
- Image: Ubuntu 24.04 LTS
- SSH key 등록
- Cloud firewall 미사용 (ufw로 직접 관리 — DEPLOY.md §4.3)

### 3.2 DNS 채우기

서버 IP 받으면 Cloudflare DNS 에:

```
api.withfina.com       A  <IP>  proxy ON  (orange cloud)
coolify.withfina.com   A  <IP>  proxy ON
```

(`www.withfina.com`, `withfina.com` 은 Vercel 가리키는 기존 record 그대로)

### 3.3 서버 hardening (DEPLOY.md §4)

1. SSH 첫 접속 (root + 키)
2. `deploy` user 생성 + sudo 권한
3. root SSH 차단 + password auth 차단
4. ufw + **Cloudflare IP allowlist script** ← origin IP 노출 방지
5. fail2ban + unattended-upgrades
6. swap 1 GB (CX23 RAM 4 GB → swap 1~2 GB 보험)

### 3.4 Coolify 설치 (DEPLOY.md §5~§6)

1. `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`
2. Coolify UI → `coolify.withfina.com` 도메인 설정
3. Origin Cert 등록 (`/data/coolify/proxy/certs/withfina.com.crt`)
4. **Cloudflare Access (Zero Trust) 로 Coolify UI 보호**
   - 본인 이메일만 허용
   - 외부에서 콘솔 절대 노출 금지

### 3.5 Postgres + API 배포 (DEPLOY.md §9~§10)

1. Coolify → Resources → New → Postgres (15 또는 16)
2. New Resource → Application →
   - Repository: GitHub `fina` repo
   - Branch: `main`
   - Build pack: **Dockerfile**
   - Dockerfile path: `apps/api/Dockerfile.prod`
   - Build context: repo root (`.`)
   - Port: 4000
   - Domain: `api.withfina.com`
3. Environment Variables: `.env.production.example` 따라 모두 채우기
4. Deploy → 로그 확인 → `curl https://api.withfina.com/health` 200 확인

### 3.6 Webhook 등록 (DEPLOY.md §12)

- **Plaid**: Dashboard → Webhooks → `https://api.withfina.com/plaid/webhook`
- **Stripe**: Dashboard → Webhooks → `https://api.withfina.com/stripe/webhook`
  - Event: `customer.subscription.*`, `invoice.payment_failed`, 등
  - signing secret을 `STRIPE_WEBHOOK_SECRET` 에 복사

### 3.7 백업 (DEPLOY.md §13)

1. Cloudflare R2 bucket `fina-backups` + API token 발급
2. Coolify → Postgres → Backups → S3 destination
   - Endpoint: `https://<account>.r2.cloudflarestorage.com`
   - Bucket: `fina-backups`
   - Schedule: `0 5 * * *` (UTC 05:00 = ET 01:00)
   - Retention: 30 daily + 12 monthly
3. **Restore test 1회 실행** ← 필수. 안 해보면 백업 의미 없음.

---

## 4. Launch 전 final QA

### 4.1 기능 검증

- [ ] `https://withfina.com` 로딩 + sign-up 동작
- [ ] sign-up → 이메일 OTP 도착 → 인증 → 자동 로그인
- [ ] Plaid Link → 은행 연결 → 거래 sync
- [ ] 카테고리 자동 분류 (Gemini)
- [ ] Stripe checkout → Lite/Pro 결제 → tier 업그레이드 반영
- [ ] Push notification (모바일 빌드 + 디바이스 등록 후 daily brief)

### 4.2 비기능 검증

- [ ] `/health` 200 (DB 응답 정상)
- [ ] API 응답 시간 p95 < 500ms (간단한 GET)
- [ ] Cloudflare WAF: Bot Fight Mode ON, Security Level Medium
- [ ] ufw 상태: `sudo ufw status` → Cloudflare IPs + 22번만 open
- [ ] Postgres connection pool 정상 (Prisma `PRISMA_CONNECTION_LIMIT=10`)
- [ ] Backup 1회 dump → R2 업로드 확인
- [ ] **Restore test** — 빈 DB에 복원해서 데이터 일치 확인

### 4.3 운영 준비

- [ ] Better Stack (또는 Uptime Robot) — `https://api.withfina.com/health`
      1분 ping, Slack/email 알림
- [ ] Cloudflare Analytics 즐겨찾기
- [ ] Coolify 알림 (실패 시 Slack/email)
- [ ] Stripe live mode 알림 (결제 실패 등)
- [ ] Plaid webhook 실패 dashboard 확인 routine

---

## 5. Day-2 운영

### 5.1 정기 작업

| 빈도 | 작업 |
|---|---|
| 매일 | Postgres backup 자동 — alert 만 모니터 |
| 주 1회 | `sudo apt update && sudo apt upgrade` (unattended-upgrades 가 자동 처리하지만 점검) |
| 월 1회 | Cloudflare Analytics 트래픽 검토, R2 사용량 확인 |
| 분기 1회 | **Restore drill** — 백업이 진짜 복구되는지 검증 |
| 분기 1회 | Stripe / Plaid 알림 설정 재점검 |

### 5.2 비밀번호 / 키 회전

- `BETTER_AUTH_SECRET` — 6개월마다 회전 가능 (기존 세션 무효화됨, 모든 사용자 재로그인)
- `STRIPE_WEBHOOK_SECRET` — webhook endpoint 교체 시
- Plaid `PLAID_SECRET` — Plaid dashboard 에서 회전
- **`ENCRYPTION_KEY` 절대 회전 금지** — DB 전체 access_token 재암호화 필요

### 5.3 incident response

- API 500 spike → Coolify 로그 → 원인 파악 → rollback (Coolify 한 클릭)
- DB 장애 → `/health` 503 → 백업에서 restore (DR runbook DEPLOY.md §15)
- DDoS → Cloudflare WAF challenge 자동 + Security Level "Under Attack" 수동 토글

---

## 6. 두 번째 프로젝트 추가 시

Coolify 서버 하나에 multi-tenant 가능. 새 프로젝트는:

1. Cloudflare 새 zone (또는 sub-domain)
2. Origin Cert (`*.<도메인>` 발급 OR 기존 cert 재사용)
3. Coolify → New Application → 같은 서버
4. Postgres 별도 resource (스키마 격리)

CX23 한 대로 **2~3개 small 프로젝트** 까지는 무리 없음. RAM 4 GB 가
한계 — 모니터링 보면서 부족하면 CX33 (8 GB) 로 resize.

---

## 7. 다음 행동 (이번 주)

**사용자 행동**:
1. SSH key 결정 → 알려주기
2. Hetzner CX23 Ashburn 주문 → IP 알려주기
3. **Plaid production 신청 시작** (가장 오래 걸림)
4. Resend domain verify (`withfina.com`)
5. Cloudflare R2 bucket 만들기

**Claude 행동 (서버 IP 받으면)**:
1. DEPLOY.md §3~§6 함께 진행
2. Coolify 설치 + Cloudflare Access 보호
3. API 첫 deploy + smoke test
4. Backup setup + restore test

서버 IP 받는 대로 다음 단계 시작합니다.
