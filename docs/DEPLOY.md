# Fina — Production Deploy Guide

**Stack**: Hetzner CX22 (Ashburn US-east) + Coolify + Docker
**예상 비용**: ~$6/월 (VPS $5 + Backblaze B2 $0.50 + 도메인 amortized)
**예상 시간**: 1.5-2시간 (도메인 propagation 제외)
**대상 사용자**: 캐나다 + 미국

---

## 0. 사전 준비물 체크리스트

deploy 시작 전에 확보:

- [ ] **신용카드** — Hetzner, 도메인, B2 결제용
- [ ] **도메인** (예: `fina.app`) — Namecheap / Porkbun / Cloudflare Registrar 추천 ($10-15/년)
- [ ] **GitHub repo** 가 private 또는 public, main branch 가 deploy 대상
- [ ] **SSH key pair** — 없으면 `ssh-keygen -t ed25519 -C "fina-deploy"` 로 생성
- [ ] **Production env vars** — `docs/LAUNCH.md` §2 참고하여 값 준비:
  - `BETTER_AUTH_SECRET` (`openssl rand -base64 32`)
  - `ENCRYPTION_KEY` (`openssl rand -base64 32`)
  - Plaid production credentials (승인 1-3일 소요 — 미리 신청)
  - Stripe production keys
  - Gemini API key
  - (선택) Resend API key, Expo Access Token
- [ ] **Backblaze B2 계정** — 무료 가입, application key 1개 발급

---

## 1. 도메인 + DNS 사전 작업 (먼저 시작 — propagation 시간 필요)

도메인을 구입했다면 DNS provider 에 다음 record 등록:

```
Type   Name              Value                    TTL
A      fina.app          <Hetzner_IP_나중에>       300
A      api.fina.app      <Hetzner_IP_나중에>       300
A      coolify.fina.app  <Hetzner_IP_나중에>       300
A      www.fina.app      <Hetzner_IP_나중에>       300
```

VPS 만들기 전이므로 IP 는 아직 모름. **§2 끝에서 IP 확보 후 채워넣음**. 미리 record placeholder 만들어두면 propagation 시간 단축.

**Cloudflare 사용 시**: proxy (orange cloud) 는 **OFF** 로. Coolify Traefik 이 직접 HTTPS 인증서 발급하려면 origin 으로 직접 hit 해야 함. Cloudflare proxy 는 향후 별도 plan.

---

## 2. Hetzner VPS provisioning

### 2.1 계정 생성

1. https://hetzner.com/cloud → **Sign Up**
2. 이메일 verification → 신용카드 등록
3. 가끔 ID 사진 요청 받음 (운전면허/여권 사진 업로드). 무시하지 말고 답변.

### 2.2 Cloud Console 에서 서버 생성

1. https://console.hetzner.cloud → **New Project** (예: `fina`)
2. **Add Server** 클릭
3. 설정값:

```
Location: Ashburn (us-east) ⭐
Image: Ubuntu 24.04
Type: Shared vCPU > CX22 (4 vCPU / 8GB / 80GB SSD, €4.51/월)
Networking: IPv4 + IPv6 (default)
SSH keys: 미리 ssh-keygen 한 공개키 paste (~/.ssh/id_ed25519.pub)
Firewalls: skip (Coolify 안에서 처리)
Volumes: skip
Placement Groups: skip
Labels: skip
Name: fina-prod (의미있는 이름)
```

4. **Create & Buy now** → 1분 안에 IP 발급
5. IP 확인 후 §1 의 DNS record 4개 값 채워넣음

### 2.3 첫 SSH 접속

```bash
ssh root@<your-server-ip>
# 첫 접속 시 fingerprint 확인 → yes
```

성공하면 prompt 가 `root@fina-prod:~#` 로 변함.

---

## 3. Ubuntu 보안 hardening (15분, 필수)

**root 로 ssh 한 상태에서:**

### 3.1 시스템 update

```bash
apt update && apt upgrade -y
apt install -y ufw fail2ban unattended-upgrades curl gnupg
```

### 3.2 새 sudo user 만들고 root SSH 차단

```bash
adduser deploy   # password 설정 (저장)
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

새 터미널에서 검증:
```bash
ssh deploy@<your-server-ip>  # 성공해야 함
```

성공 확인 후 root SSH 차단:
```bash
sudo nano /etc/ssh/sshd_config
# 다음 라인들 수정 (있으면 변경, 없으면 추가):
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes

sudo systemctl restart sshd
```

검증:
```bash
ssh root@<ip>  # "Permission denied" 떠야 정상
ssh deploy@<ip>  # 성공해야 함
```

### 3.3 방화벽 (ufw)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP (Let's Encrypt challenge)
sudo ufw allow 443/tcp    # HTTPS
sudo ufw allow 8000/tcp   # Coolify UI (나중에 IP whitelist 로 좁힘)
sudo ufw --force enable
sudo ufw status numbered
```

### 3.4 fail2ban (brute-force 차단)

```bash
sudo systemctl enable --now fail2ban
sudo systemctl status fail2ban    # active 확인
```

기본 jail (sshd) 가 자동 enable 됨.

### 3.5 자동 보안 업데이트

```bash
sudo dpkg-reconfigure -plow unattended-upgrades
# UI 에서 "Yes" 선택
```

### 3.6 swap 추가 (8GB RAM 인데 안전망)

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -h  # Swap 4Gi 보여야 함
```

---

## 4. Coolify 설치 (10분)

```bash
# deploy user 로 ssh 한 상태에서:
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

설치 완료 후 출력에 표시되는 URL: `http://<your-ip>:8000`

브라우저에서 접속 → 첫 root 계정 생성 (email + password).

### 4.1 Coolify UI 접근 보안

Coolify UI (port 8000) 가 인터넷 전체에 노출되어 있음. 2가지 옵션:

**옵션 A — IP whitelist (간단)**:
```bash
sudo ufw delete allow 8000/tcp
sudo ufw allow from <your-home-ip>/32 to any port 8000
```
`<your-home-ip>` = 너의 현재 IP (https://whatismyipaddress.com)
단점: 집/카페 옮길 때마다 ufw 수정 필요.

**옵션 B — coolify.fina.app 도메인 + Traefik 으로 8000 안 노출 (권장)**:

Coolify Settings → Instance Settings → "Instance Domain" 에 `coolify.fina.app` 입력 → save.
Traefik 이 자동 routing + HTTPS.
그 다음:
```bash
sudo ufw delete allow 8000/tcp
```

이후 `https://coolify.fina.app` 로 접근.

---

## 5. GitHub 연결

Coolify UI → **Sources** → **Add New Source** → **GitHub App**:

1. "Register a new GitHub App" 클릭
2. Coolify 가 GitHub 로 redirect → app 이름 (예: `Coolify-Fina`) 적고 create
3. GitHub 에서 repo install: **Only select repositories** → `fina` 선택
4. Coolify 가 자동으로 connection 등록

---

## 6. Production Dockerfile 작성

deploy 전에 repo 에 production Dockerfile 이 있어야 함. (이게 없으면 다음 step 으로 가지 마세요.)

이 step 은 별도 commit 으로 만들 가치 있음. **별도 작업**으로 분리 권장 (이 가이드 §13 의 "다음 단계").

기본 구조 (참고용):

```dockerfile
# apps/api/Dockerfile.prod (Nx + pnpm + Prisma 고려)
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY libs/shared/package.json libs/shared/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm --filter @fina/api exec prisma generate
RUN pnpm --filter @fina/api build

FROM node:22-alpine
RUN apk add --no-cache dumb-init
RUN addgroup -S fina && adduser -S fina -G fina
WORKDIR /app
COPY --from=builder --chown=fina:fina /app/node_modules ./node_modules
COPY --from=builder --chown=fina:fina /app/apps/api/dist ./dist
COPY --from=builder --chown=fina:fina /app/apps/api/prisma ./prisma
COPY --from=builder --chown=fina:fina /app/apps/api/package.json ./
USER fina
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:3000/healthz || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
```

이 Dockerfile 은 Fina monorepo 구조 맞춰 별도 검증 필요. 이 가이드의 후속 작업으로 다듬어야 함.

---

## 7. Postgres in Coolify

Coolify UI → **Projects** → **New Project** (예: `fina`) → **Add Resource** → **Database** → **Postgres 16**:

설정:
```
Server: localhost (Coolify 가 있는 VPS)
Name: fina-postgres
Database name: fina
Username: fina
Password: <auto-generated, 복사해서 저장>
```

**Save & Start**. 1분 안에 컨테이너 떠야 함.

내부 connection string (Coolify 가 자동 생성, env vars 에 사용):
```
postgresql://fina:<password>@fina-postgres:5432/fina
```

`fina-postgres` 는 Docker network 내부 hostname. API 컨테이너에서 접근 가능.

---

## 8. Fina API deploy

같은 Project (`fina`) 안에서 **Add Resource** → **Application** → **Public Repository (or GitHub App)** → 너의 fina repo 선택:

설정:
```
Branch: main
Build Pack: Dockerfile
Dockerfile path: apps/api/Dockerfile.prod  (§6 의 Dockerfile)
Base directory: /
Port (exposes): 3000
Domain: api.fina.app
HTTPS: 자동 (Let's Encrypt)
```

**Environment Variables** 탭 → `docs/LAUNCH.md` §2 의 모든 required env 입력:
- `DATABASE_URL` = §7 의 connection string
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WEB_APP_URL`
- `STRIPE_*` (4개)
- `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=production`
- `ENCRYPTION_KEY`
- `GEMINI_API_KEY`
- (선택) `EXPO_ACCESS_TOKEN`, `RESEND_API_KEY`

`NODE_ENV=production` 도 추가.

**Save & Deploy** → Coolify 가 GitHub clone → Docker build → start. 첫 build 5-10분 (이후 cache 로 빠름).

배포 로그를 Coolify UI 에서 실시간으로 봐서 에러 없는지 확인.

### 8.1 첫 deploy 후 검증

```bash
curl https://api.fina.app/healthz
# {"status":"ok"} 비슷한 응답 와야 함
```

DNS propagation 안 됐으면 5-30분 기다림. 그래도 안 되면 Coolify UI 에서 도메인 설정 재확인.

### 8.2 Database migration

첫 deploy 후 마이그레이션이 자동으로 안 됐다면 수동 1회:

Coolify UI → fina-api Application → **Terminal** (또는 SSH 로 VPS 접속 후):
```bash
docker exec -it <fina-api-container> pnpm --filter @fina/api exec prisma migrate deploy
```

이후 deploy 마다 자동 migration 원하면 Dockerfile 의 CMD 를 다음과 같이:
```dockerfile
CMD sh -c "pnpm prisma migrate deploy && node dist/main.js"
```

---

## 9. Fina Web 배포 (선택)

### 옵션 A: Coolify 에 같이 (모든 인프라 single VPS)

§8 과 동일한 절차로 새 Application 추가:
- Branch: main
- Build Pack: Dockerfile (apps/web/Dockerfile.prod 작성 필요)
- Port: 3000 (Next.js default)
- Domain: `fina.app`
- Env: `NEXT_PUBLIC_API_URL=https://api.fina.app`

### 옵션 B: Vercel 에 분리 (CDN + edge runtime, 무료)

```bash
cd apps/web
pnpm dlx vercel    # 첫 setup
# 도메인 fina.app 등록 → Vercel 에서 nameservers 설정 안내
```

**권장**: 옵션 B (Vercel). Next.js 는 Vercel 에 최적화, 무료 plan 충분. API 만 Hetzner.

---

## 10. Plaid + Stripe webhook 등록

`https://api.fina.app` 가 살아있으면:

### Plaid

1. https://dashboard.plaid.com → API → Webhooks
2. **Webhook URL**: `https://api.fina.app/plaid/webhook`
3. **Webhook signing key** 발급 → env `PLAID_WEBHOOK_SECRET` 으로 추가 (코드가 사용 중이면)

### Stripe

1. https://dashboard.stripe.com/webhooks → **Add endpoint**
2. URL: `https://api.fina.app/stripe/webhook`
3. Events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `checkout.session.completed`
4. **Signing secret** (`whsec_...`) → env `STRIPE_WEBHOOK_SECRET` 으로 추가
5. Coolify 에서 fina-api restart

---

## 11. Backup 설정 (필수!)

### 11.1 Backblaze B2 setup

1. https://backblaze.com/cloud-storage → Sign up (10GB 무료)
2. **Buckets** → **Create Bucket**:
   - Name: `fina-backups`
   - Files in Bucket: **Private**
   - Region: `us-west-001` (us 동부 → 동부 backup 은 cross-region 보안에 좋음)
3. **App Keys** → **Add a New Application Key**:
   - Name: `fina-coolify`
   - Bucket: `fina-backups` (한정)
   - Type: read+write
   - Save: **keyId** + **applicationKey** (둘 다 한 번만 표시!)

### 11.2 Coolify backup

fina-postgres resource → **Backups** 탭:

```
Frequency: 0 3 * * *  (매일 3am UTC = 미국 동부 11pm)
Retention: 7 days (B2)
Destination type: S3-compatible
Endpoint: https://s3.us-west-001.backblazeb2.com
Bucket: fina-backups
Access key: <keyId>
Secret key: <applicationKey>
```

**Save** + **Run Backup Now** (수동 1회 실행) → B2 콘솔 가서 파일 생성됐는지 확인.

### 11.3 Restore test (반드시 1회)

**이 단계 빠뜨리지 마세요.** 검증 안 된 backup 은 backup 이 아님.

1. B2 → `fina-backups` → 가장 최신 `.sql.gz` 다운로드
2. 로컬 또는 별도 VPS 에 Postgres 띄움:
```bash
docker run --rm -d --name pg-test -e POSTGRES_PASSWORD=test postgres:16-alpine
gunzip -c backup-2026-05-XX.sql.gz | docker exec -i pg-test psql -U postgres
docker exec -it pg-test psql -U postgres -c "\dt"  # 테이블 보여야 함
docker exec -it pg-test psql -U postgres -c "SELECT count(*) FROM users;"  # 데이터 들어옴
docker stop pg-test
```

성공하면 backup 시스템 OK.

---

## 12. Mobile app 배포

mobile 은 hosting 무관 (Expo cloud + App Store / Play Store):

1. `apps/mobile/.env.local` 에 production 값:
```
EXPO_PUBLIC_API_URL=https://api.fina.app
```
2. `pnpm --filter @fina/mobile exec eas build --profile production --platform all`
3. EAS Submit → TestFlight / Play Store internal track
4. (사전 작업: `eas init` 은 이미 완료 — `docs/LAUNCH.md` §1 참조)

---

## 13. Day-2 ops

### 로그 보기
- Coolify UI → fina-api → **Logs** (실시간)
- 또는 SSH: `docker logs -f <fina-api-container>`

### Restart
- Coolify UI → fina-api → **Restart** (zero-downtime rolling)

### Update (코드 변경)
- `git push origin main` → Coolify webhook → auto deploy. **추가 작업 없음.**

### Env var 변경
- Coolify UI → fina-api → **Environment Variables** 수정 → save → restart

### Coolify 자체 업데이트
- Coolify UI → Settings → Update. 한 달에 1번 정도.

### 호스트 OS 업데이트
- `unattended-upgrades` 가 보안 패치 자동 적용
- kernel 업데이트 시 reboot 필요:
```bash
ls /var/run/reboot-required && sudo reboot
```

---

## 14. Monitoring (간단)

기본은 Coolify dashboard 가 CPU/memory 보여줌. 부족하면:

**옵션 A — Uptime Kuma (외부 health check)**:
- 별도 작은 VPS or Render 무료 plan 에 설치
- `https://api.fina.app/healthz` 1분 간격 ping
- 다운 시 email/Discord 알림

**옵션 B — Better Stack (managed, 무료 plan)**:
- https://betterstack.com → 무료 monitor 등록
- Coolify 안 깔아도 됨

---

## 15. 다음 서비스 추가

새 서비스 deploy 할 때:

1. Coolify → **New Project** (이름 `service2`)
2. **Add Resource** → Application → GitHub repo 선택
3. Domain 등록 (`service2.app` DNS A record → 같은 Hetzner IP)
4. Coolify Traefik 이 자동 routing
5. (선택) 별도 Postgres 추가 (DB-level isolation)

**같은 VPS 위에서 fina + service2 + service3 모두 운영 가능.** RAM 8GB → 각 service ~1GB 잡으면 6개까지.

---

## 16. 마이그레이션 트리거 (성장 시)

각 트리거에서 인프라 조정:

| 시점 | 조정 |
|---|---|
| 사용자 50+ (DB 가 SLA 필요) | Postgres → Neon ($19/월) 또는 Supabase |
| 사용자 500+ (API CPU 압박) | VPS upgrade → CPX31 ($10/월) or 별도 머신 |
| 사용자 5000+ | API → Fly.io multi-region. VPS 는 cron/admin 전용 |
| 한국 사용자 비중 큼 | Hetzner Singapore 에 별도 region |

전부 Docker 라 마이그레이션 = `docker-compose.yml` 이동 + DNS 변경.

---

## 17. 트러블슈팅

### "502 Bad Gateway" 가 도메인 접속 시
- DNS propagation 안 됨 (5-30분 대기) OR
- Coolify 의 도메인 설정에서 port mismatch — UI 에서 port 확인 (Fina API = 3000)
- 컨테이너 죽음 — Coolify Logs 확인

### "SSL_ERROR_NO_CYPHER_OVERLAP" 같은 HTTPS 에러
- Let's Encrypt 인증서 발급 실패 — DNS A record 가 정확히 Hetzner IP 가리키는지 확인
- Cloudflare proxy ON 이면 발급 막힘 → OFF

### Coolify UI 안 뜸
- ufw 가 8000 차단 했나? `sudo ufw status`
- Coolify 서비스 down? `sudo systemctl status coolify` 또는 `docker ps | grep coolify`

### Deploy fail "out of memory"
- Docker build 가 8GB 부족 — swap 늘리거나, builder stage 를 Coolify Build Server 옵션 활용
- Prisma generate 가 많이 먹음 — `.dockerignore` 로 불필요 파일 배제

### Postgres connection refused
- `DATABASE_URL` 의 hostname 이 컨테이너 이름인지 (`fina-postgres`) 또는 `localhost` 인지 — Coolify 내부 네트워크에서는 컨테이너 이름

### Plaid webhook 안 옴
- `https://api.fina.app/plaid/webhook` 가 200 응답하는지: `curl -X POST -d '{}' https://api.fina.app/plaid/webhook` → 401/400 정상 (signature check). 500 이면 코드 문제.
- Plaid 대시보드 → Webhooks → Recent Activity 에 delivery 시도 기록 있는지

---

## 18. 보안 추가 checklist (배포 후)

- [ ] Hetzner cloud firewall 추가 활성화 (UI 에서 — VPS-level, ufw 외 한 겹)
- [ ] SSH port 변경 (선택, 22 → 22222 — bot scan 줄음)
- [ ] **Coolify UI 비밀번호 강력**, 2FA 활성화 (Settings → Authentication)
- [ ] DB backup 매주 restore test (자동화 가능 — 별도 plan)
- [ ] `npm audit` / `pnpm audit` CI 에 추가
- [ ] Sentry / Logflare 등 error tracking 등록 (선택)
- [ ] Rate limiting on API — 이미 Fastify 에 있는지 코드 검토
- [ ] Plaid + Stripe webhook signature verification 코드에서 enforced 인지 확인

---

## 19. 비용 monthly check

월말 가볍게 확인:
- Hetzner: €4.51 (~$5)
- Backblaze B2: download cost 적나 — Coolify backup 만 하면 거의 0
- 도메인: $1/월 amortized
- (옵션) Cloudflare proxy / Sentry: 무료 plan
- **총 ~$6-7/월**

사용자 늘면 §16 트리거 기준으로 단계적 업그레이드.

---

## 부록: 빠른 disaster recovery

전체 VPS 가 죽었을 때:

1. Hetzner 에서 새 CX22 같은 region 에 provision (5분)
2. SSH 보안 hardening (§3, 15분)
3. Coolify install (§4, 10분)
4. Coolify UI 에서 fina project 만들고 GitHub 다시 연결 (5분)
5. Postgres 컨테이너 띄우고 **B2 backup 에서 restore**:
```bash
ssh deploy@<new-ip>
# B2 에서 최신 backup 다운로드
rclone copy b2:fina-backups/latest.sql.gz ./
gunzip -c latest.sql.gz | docker exec -i <postgres-container> psql -U fina fina
```
6. fina-api Application redeploy (5분)
7. DNS A record 새 IP 로 업데이트 (15-30분 propagation)

**총 ~1시간**. Backup + restore test 가 검증돼 있으면 stress-free.

---

## 끝: 1.5-2시간이면 production live

이 가이드는 step-by-step. 막히면 Coolify Discord 또는 Hetzner community 검색. 대부분의 케이스는 검증된 솔루션 있음.

다음 작업 (코드 쪽):
- `apps/api/Dockerfile.prod` 작성 + 로컬 build 검증
- `apps/web/Dockerfile.prod` (Vercel 안 쓸 경우)
- `apps/api/src/main.ts` 가 `/healthz` 엔드포인트 가지는지 확인
- Graceful shutdown (SIGTERM 처리 — Fastify 가 기본 제공)
