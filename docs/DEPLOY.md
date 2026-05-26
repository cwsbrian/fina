# Fina — Production Deploy Guide (Cloudflare-integrated)

**Stack**: Cloudflare (DNS + WAF + Access) → Hetzner CX22 (Ashburn US-east) → Coolify → Docker

**예상 비용**: ~$6/월 (Hetzner $5 + B2 backup $0.5 + 도메인 amortized). Cloudflare 무료 plan.

**예상 시간**: 2-3시간 (DNS propagation 30분-1시간 포함)

**대상 사용자**: 캐나다 + 미국

---

## 보안 아키텍처 (한 눈에)

```
                    User (Canada/US)
                         │
                         ▼ HTTPS
              ╔══════════════════════╗
              ║   Cloudflare Edge    ║ ← WAF, DDoS, Bot mgmt, CDN
              ║   (orange-cloud)     ║   Edge cert (CF managed)
              ╚══════════════════════╝
                         │ HTTPS (Origin Cert)
                         ▼
         ┌───────────────────────────────────────┐
         │ Hetzner CX22 (Ashburn)                │
         │ ufw allowlist = Cloudflare IPs only   │
         │                                       │
         │  ┌─ Traefik (80/443) ─────────────┐   │
         │  │   ↓ Origin Cert TLS            │   │
         │  ├─ api.fina.app  → fina-api      │   │
         │  ├─ fina.app      → fina-web      │   │
         │  └─ coolify.fina.app → Coolify UI │   │
         │       ↑ Cloudflare Access (OAuth) │   │
         │  fina-postgres (internal-only)    │   │
         └───────────────────────────────────────┘
```

**핵심 보안 properties**:
- Hetzner Origin IP **숨김** (Cloudflare 만 알고 있음)
- Hetzner VPS **80/443 port 가 Cloudflare IPs 에만 열림** — 다른 IP 는 firewall 차단
- Coolify UI 는 Cloudflare Access OAuth gate 통과해야 접근 가능
- Plaid/Stripe webhook 은 Cloudflare 통과 — 자동 challenge 안 걸림 (known bot exception)

---

## 0. 사전 준비 checklist

- [ ] **신용카드** — Hetzner, 도메인, B2
- [ ] **도메인 선택** — Cloudflare Registrar 추천 (도매가 = 가장 저렴, $9-12/년). 또는 Namecheap/Porkbun.
- [ ] **Cloudflare 계정** — https://cloudflare.com (무료 plan)
- [ ] **GitHub repo** — Fina, main branch
- [ ] **SSH key** — `ssh-keygen -t ed25519 -C "fina-deploy"`
- [ ] **Backblaze B2 계정** — backup destination (10GB 무료)
- [ ] **Production env vars** — `docs/LAUNCH.md` §2 참고하여 값 미리 준비

---

## 1. Cloudflare zone 생성 (도메인 nameserver 작업, 가장 먼저)

### 1.1 Cloudflare 에 도메인 등록

1. https://dash.cloudflare.com → **Add a Site** → 도메인 입력 (예: `fina.app`)
2. **Free** plan 선택
3. Cloudflare 가 기존 DNS record scan → 그대로 import. 일단 record 없으면 skip.
4. Cloudflare 가 nameserver 2개 발급 (예: `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com`)
5. **도메인 registrar 가서 nameserver 변경**:
   - Namecheap/Porkbun/기타: Domain → DNS → "Custom DNS" → CF nameserver 입력
   - Cloudflare Registrar 면 자동
6. Propagation: 5분-24시간. Cloudflare dashboard 가 "Active" 로 바뀌면 완료.

### 1.2 DNS records (proxy ON, orange cloud)

DNS propagation 끝나면 Cloudflare dashboard → **DNS** → **Records** 에서 추가. **Hetzner IP 는 아직 모르므로 §3 끝에서 채움**.

```
Type   Name              Content                  Proxy
A      fina              <Hetzner_IP>             ON (proxied)
A      api               <Hetzner_IP>             ON
A      coolify           <Hetzner_IP>             ON
CNAME  www               fina.app                 ON
```

**`Proxy ON` = orange cloud icon**. 이게 모든 traffic 을 Cloudflare 가 가로채고 origin 숨김.

### 1.3 SSL/TLS 모드 설정

Cloudflare dashboard → **SSL/TLS** → **Overview**:
- Mode: **Full (strict)** ⭐ — origin 인증서 검증 활성화 (Origin Cert 사용)

**SSL/TLS → Edge Certificates**:
- **Always Use HTTPS**: ON
- **Automatic HTTPS Rewrites**: ON
- **Minimum TLS Version**: TLS 1.2
- **Opportunistic Encryption**: ON
- **TLS 1.3**: ON

---

## 2. Cloudflare Origin Certificate 발급

Cloudflare 가 발급하는 **15년 valid** 인증서. Origin 에 설치하면 Cloudflare 가 검증 OK.

1. Cloudflare dashboard → **SSL/TLS** → **Origin Server**
2. **Create Certificate**
3. 설정:
```
Private key type: RSA (2048)
Hostnames: *.fina.app, fina.app
Certificate Validity: 15 years
```
4. **Create** → 화면에 표시되는 2가지 저장 (**한 번만 표시됨**):
   - **Origin Certificate** (PEM, `-----BEGIN CERTIFICATE-----` 로 시작)
   - **Private Key** (PEM, `-----BEGIN PRIVATE KEY-----` 로 시작)

로컬에 임시 저장 (나중에 Coolify 에 paste):
```
~/secrets/fina-origin-cert.pem
~/secrets/fina-origin-key.pem
```

**⚠️ Private key 는 절대 git 에 commit 안 함.** 안전한 곳에 저장.

---

## 3. Hetzner VPS provisioning

### 3.1 계정 생성

1. https://hetzner.com/cloud → Sign Up
2. 신용카드 + email verification
3. 가끔 ID 사진 요구 — 답변 필수

### 3.2 서버 생성

Cloud Console → **New Project** (예: `fina`) → **Add Server**:

```
Location: Ashburn (us-east) ⭐ (Plaid US infra 와 같은 region)
Image: Ubuntu 24.04
Type: CX22 (4 vCPU / 8GB / 80GB, €4.51/월)
Networking: IPv4 + IPv6
SSH keys: ssh-keygen 결과 paste (~/.ssh/id_ed25519.pub)
Firewalls: skip (ufw + Cloudflare 로 처리)
Name: fina-prod
```

**Create & Buy now** → 1분 안에 IPv4 발급.

### 3.3 §1.2 DNS records 에 IP 채우기

발급된 IP 를 Cloudflare DNS records 4개에 채워넣기. **Proxy ON 유지**.

### 3.4 첫 SSH 접속

```bash
ssh root@<your-server-ip>
```

---

## 4. Ubuntu 보안 hardening + Cloudflare IP allowlist

### 4.1 시스템 update + 패키지

```bash
apt update && apt upgrade -y
apt install -y ufw fail2ban unattended-upgrades curl gnupg jq
```

### 4.2 deploy user 생성, root SSH 차단

```bash
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys

# 새 터미널에서 ssh deploy@<ip> 검증 후:
nano /etc/ssh/sshd_config
# PermitRootLogin no
# PasswordAuthentication no
# PubkeyAuthentication yes
systemctl restart sshd
```

검증:
```bash
ssh root@<ip>  # Permission denied 떠야 정상
ssh deploy@<ip>  # 성공
```

### 4.3 ufw + Cloudflare IPs 허용 script

**일반 ufw 설정**:
```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp  # SSH (전 세계)
# 80/443 은 Cloudflare IPs 만 — 아래 script
sudo ufw --force enable
```

**Cloudflare IP allowlist 자동화 script**:
```bash
sudo nano /usr/local/bin/cf-allowlist.sh
```
내용:
```bash
#!/bin/bash
# Cloudflare IP ranges → ufw 에 80/443 allow
set -euo pipefail

# 기존 CF allow rules 제거 (comment 로 mark)
sudo ufw status numbered | grep "CF-allow" | awk '{print $2}' | sed 's/]//' \
  | sort -rn | xargs -I{} sudo ufw --force delete {} 2>/dev/null || true

# 최신 Cloudflare IP ranges fetch + ufw 추가
for ip in $(curl -fsSL https://www.cloudflare.com/ips-v4); do
  sudo ufw allow proto tcp from "$ip" to any port 80,443 comment "CF-allow"
done
for ip in $(curl -fsSL https://www.cloudflare.com/ips-v6); do
  sudo ufw allow proto tcp from "$ip" to any port 80,443 comment "CF-allow"
done

sudo ufw reload
echo "Cloudflare allowlist updated: $(date)"
```
```bash
sudo chmod +x /usr/local/bin/cf-allowlist.sh
sudo /usr/local/bin/cf-allowlist.sh
sudo ufw status verbose  # CF IPs 가 80,443 에 allowed 보여야 함
```

**월 1회 자동 갱신** (Cloudflare IP list 변경 대비):
```bash
sudo crontab -e
# 추가:
0 4 1 * * /usr/local/bin/cf-allowlist.sh >> /var/log/cf-allowlist.log 2>&1
```

이제 **Cloudflare IP 외에는 80/443 접근 불가**. Origin 보호 완료.

### 4.4 fail2ban + 자동 보안 업데이트

```bash
sudo systemctl enable --now fail2ban
sudo dpkg-reconfigure -plow unattended-upgrades  # UI: Yes
```

### 4.5 swap (안전망)

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 5. Coolify 설치

```bash
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

설치 완료 후 출력 URL: `http://<your-ip>:8000`

⚠️ 현재 ufw 가 8000 을 막고 있으므로 외부에서 접근 안 됨. **SSH tunnel 로 첫 접속**:

로컬 머신에서:
```bash
ssh -L 8000:localhost:8000 deploy@<your-ip>
# 그대로 둠
```

브라우저에서 `http://localhost:8000` → Coolify root 계정 생성 (email + strong password).

---

## 6. Coolify UI 를 coolify.fina.app 으로 노출 (Cloudflare Access 보호)

Coolify UI 를 Traefik 으로 라우팅 → Cloudflare 통과 → Cloudflare Access OAuth gate.

### 6.1 Coolify Instance Settings

Coolify UI (SSH tunnel) → **Settings** → **Instance Settings**:

```
Instance Domain: https://coolify.fina.app
```

**Save**. Coolify 가 자체 Traefik 설정 갱신.

### 6.2 Origin Certificate 등록

같은 페이지 → **Custom Certificate** 섹션 또는 Traefik 설정:

Coolify v4 의 경우 SSH 로 직접 cert 설치:
```bash
sudo mkdir -p /data/coolify/proxy/certs
sudo nano /data/coolify/proxy/certs/fina.app.crt
# §2 의 Origin Certificate 전체 paste, save

sudo nano /data/coolify/proxy/certs/fina.app.key
# §2 의 Private Key 전체 paste, save

sudo chmod 600 /data/coolify/proxy/certs/fina.app.*
sudo chown root:root /data/coolify/proxy/certs/fina.app.*
```

Traefik dynamic config 추가:
```bash
sudo nano /data/coolify/proxy/dynamic/origin-cert.yaml
```
내용:
```yaml
tls:
  certificates:
    - certFile: /data/coolify/proxy/certs/fina.app.crt
      keyFile: /data/coolify/proxy/certs/fina.app.key
      stores: [default]
  stores:
    default:
      defaultCertificate:
        certFile: /data/coolify/proxy/certs/fina.app.crt
        keyFile: /data/coolify/proxy/certs/fina.app.key
```

Traefik restart (Coolify 가 자동으로 reload):
```bash
docker restart coolify-proxy
```

### 6.3 Cloudflare Access (Zero Trust) — Coolify UI 보호

Cloudflare dashboard → **Zero Trust** → 첫 사용 시 team domain 생성 (`fina.cloudflareaccess.com` 등 무료).

**Access** → **Applications** → **Add an application** → **Self-hosted**:
```
Application name: Coolify
Session duration: 24 hours
Application domain: coolify.fina.app
```

**Policies** → **Add a policy**:
```
Policy name: Owner only
Action: Allow
Include: Emails → your-email@gmail.com
```

다른 identity providers 추가 가능 (GitHub OAuth 등).

이제 `https://coolify.fina.app` 접속 시:
1. Cloudflare Access 페이지 → 이메일 입력 → 이메일로 one-time code → 입력
2. 통과 → Coolify UI

**SSH tunnel 더 이상 필요 없음**. 그래도 SSH 접근 자체는 별도 보안 (key-only).

---

## 7. GitHub 연결

Coolify UI → **Sources** → **Add New Source** → **GitHub App**:

1. "Register a new GitHub App" → app 이름 (예: `Coolify-Fina`)
2. GitHub install → repo 선택 (`fina`)
3. Coolify 자동 등록

---

## 8. Production Dockerfile

**별도 작업으로 분리 권장.** 이 가이드 이후 다음 단계로:

`apps/api/Dockerfile.prod` 작성 + 로컬 build 검증. 기본 구조:

```dockerfile
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
CMD sh -c "pnpm prisma migrate deploy && node dist/main.js"
```

`/healthz` 엔드포인트가 코드에 있는지 먼저 확인 (`apps/api/src/server.ts` 검색).

---

## 9. Postgres in Coolify

Coolify → **Projects** → **New Project** (`fina`) → **Add Resource** → **Database** → **Postgres 16**:

```
Server: localhost
Name: fina-postgres
Database: fina
Username: fina
Password: <auto-generated, 저장>
```

내부 connection string:
```
postgresql://fina:<password>@fina-postgres:5432/fina
```

---

## 10. Fina API deploy

같은 Project → **Add Resource** → **Application** → GitHub repo `fina` 선택:

```
Branch: main
Build Pack: Dockerfile
Dockerfile path: apps/api/Dockerfile.prod
Port: 3000
Domain: api.fina.app
Custom Certificate: ✓ (Origin Cert — §6.2 의 동일 cert 가 *.fina.app 커버하므로 자동)
```

**Environment Variables** → `docs/LAUNCH.md` §2 의 모든 required env 입력.

**Deploy** → 첫 build 5-10분.

검증 (DNS propagation 끝나면):
```bash
curl https://api.fina.app/healthz
# {"status":"ok"}
```

`curl -I` 의 response header 에 `cf-ray:` 가 보이면 Cloudflare 통과 중. ✓

---

## 11. Fina Web 배포

옵션 A (Coolify 같이): §10 과 동일, 도메인 = `fina.app`.

옵션 B (Vercel, 추천): `apps/web` 만 Vercel 에 배포. Vercel 도 Cloudflare 와 호환되지만 도메인은 Vercel 에 직접 가리킴.
- Vercel 사용 시: Cloudflare DNS 의 `fina.app` A record 를 **proxy OFF** 로 (Vercel 이 자체 cert 발급). OR Cloudflare 만 쓰고 싶으면 옵션 A.

---

## 12. Plaid + Stripe webhook 등록

### Plaid
- URL: `https://api.fina.app/plaid/webhook`
- Plaid 대시보드 → API → Webhooks → URL 등록
- Signing key 발급 → env `PLAID_WEBHOOK_SECRET`

### Stripe
- URL: `https://api.fina.app/stripe/webhook`
- Stripe → Webhooks → Add endpoint
- Events: `customer.subscription.*`, `checkout.session.completed`
- Signing secret → env `STRIPE_WEBHOOK_SECRET`

### Cloudflare 가 webhook 차단 안 함?

기본 Cloudflare WAF/Bot rules 는 Plaid + Stripe webhook 의 IP/User-Agent 를 차단 안 함. 그래도 안전을 위해:

Cloudflare → **Security** → **WAF** → **Tools** → **IP Access Rules** (선택, 신중):
- Allow rule for Stripe IPs: https://stripe.com/files/ips/ips_webhooks.json (목록 fetch)
- Plaid 는 IP range 안정적 = 추가 안 해도 OK

또는 **Bot Fight Mode 가 ON** 일 때 webhook IP 가 잘못 분류되면 차단 발생 가능. 로그 monitor:
- Cloudflare → **Security** → **Events** → webhook URL 의 challenge/block 확인. 차단 보이면 해당 IP allow rule 추가.

---

## 13. Backup (필수)

### 13.1 Backblaze B2 setup

1. https://backblaze.com/cloud-storage → Sign up
2. **Buckets** → **Create Bucket**:
   - Name: `fina-backups`
   - Files: **Private**
   - Region: `us-west-001`
3. **App Keys** → **Add a New Application Key**:
   - Bucket: `fina-backups`
   - Type: read+write
   - **keyId** + **applicationKey** 저장

### 13.2 Coolify backup

fina-postgres → **Backups** 탭:
```
Frequency: 0 3 * * *  (daily 3am UTC)
Retention: 7 days
Destination: S3
Endpoint: https://s3.us-west-001.backblazeb2.com
Bucket: fina-backups
Access key: <keyId>
Secret key: <applicationKey>
```

### 13.3 Restore test (반드시 1회)

```bash
# B2 콘솔에서 최신 .sql.gz 다운로드
docker run --rm -d --name pg-test -e POSTGRES_PASSWORD=test postgres:16-alpine
gunzip -c backup-XXXX.sql.gz | docker exec -i pg-test psql -U postgres
docker exec -it pg-test psql -U postgres -c "\dt"   # 테이블 확인
docker exec -it pg-test psql -U postgres -c "SELECT count(*) FROM users;"
docker stop pg-test
```

---

## 14. Mobile app

```
EXPO_PUBLIC_API_URL=https://api.fina.app
```
`eas build --profile production --platform all` → TestFlight + Play Store.
(`eas init` 은 이미 완료 — `docs/LAUNCH.md` §1.)

---

## 15. Day-2 ops

| 작업 | 방법 |
|---|---|
| 로그 보기 | Coolify UI → Logs |
| Restart | Coolify UI → Restart |
| Code update | `git push origin main` → auto deploy |
| Env var 변경 | Coolify UI → Env Vars → Save → Restart |
| Coolify 업데이트 | Settings → Update (월 1회) |
| OS update | unattended-upgrades 자동, kernel: `ls /var/run/reboot-required && sudo reboot` |
| Cloudflare IP 갱신 | crontab 매월 1일 자동 (§4.3) |
| Origin Cert 갱신 | 15년 후. Calendar reminder 권장. |

---

## 16. Monitoring

### Cloudflare 기본 제공
- **Analytics** → 트래픽, 성공률, latency, 위협 차단 수
- **Security Events** → 차단된 요청 inspect

### Uptime (외부 health check)
Better Stack (무료 plan): https://api.fina.app/healthz 1분 ping. 다운 시 email/Slack.

---

## 17. 다음 서비스 추가

1. Coolify → **New Project** (`service2`)
2. **Add Resource** → Application → GitHub repo
3. Cloudflare DNS: `service2.app` 도메인 zone 추가 (Step 1 반복), proxy ON
4. Origin Cert: 새 도메인용 발급 (§2 반복) OR `*.fina.app` 으로 발급해두고 `service2.fina.app` 으로 sub 도메인
5. Coolify UI 에서 domain 등록 → Traefik 자동 routing

같은 VPS 위에서 fina + service2 + service3 모두 운영. 8GB → 5-6개 서비스 가능.

---

## 18. 마이그레이션 트리거

| 시점 | 조정 |
|---|---|
| 사용자 50+ | Postgres → Neon ($19/월) |
| 사용자 500+ | VPS upgrade → CPX31 ($10/월) |
| 사용자 5000+ | API → Fly.io multi-region |
| Cloudflare Pro ($25/월) 가치 시점 | Advanced WAF + image optimization 필요 시 |

Docker 라 lock-in 없음. 마이그레이션 = compose 파일 이동.

---

## 19. 트러블슈팅

### "Error 525 (SSL Handshake Failed)" 가 도메인 접속 시
- Cloudflare SSL/TLS mode 가 Flexible 인지 확인 → **Full (strict)** 으로
- Origin Cert 가 Traefik 에 제대로 설치됐는지: `docker exec coolify-proxy ls /traefik/certs/`
- Origin Cert hostname 이 `*.fina.app` 인지 (subdomain match)

### "Error 526 (Invalid SSL Certificate)"
- Origin 의 cert 가 expired 또는 wrong domain
- §6.2 의 cert/key paste 가 정확한지 (BEGIN/END 라인 포함)

### "Error 521 (Web Server Is Down)"
- Hetzner VPS down OR ufw 가 Cloudflare 차단 (rule 위치 확인)
- `sudo ufw status numbered` → CF IPs 가 80,443 allow 인지

### Coolify UI 접근 시 Cloudflare Access 페이지 안 뜸
- Cloudflare Zero Trust → Applications → `coolify.fina.app` policy 가 정확한지
- Access policy 의 email match 가 정확한지 (`@gmail.com` vs `@anotherdomain.com`)

### Plaid webhook 안 옴
- Cloudflare → Security → Events → Plaid IPs 가 차단됐나
- 차단됐으면 IP Access Rules 에 allow 추가

### Stripe webhook timeout
- Stripe 는 30초 expect. Cloudflare latency 추가 (~10ms) — 문제 없을 것
- API 자체가 느린지 Coolify Logs 확인

### "ERR_TOO_MANY_REDIRECTS"
- Cloudflare SSL/TLS = Flexible 일 때 발생 (Flexible → HTTP origin 요청 → app 이 redirect to HTTPS → infinite loop)
- **Full (strict)** 로 변경

---

## 20. 보안 추가 checklist (배포 후 1주일 내)

- [ ] Cloudflare Access 2FA enable (Settings → Authentication)
- [ ] Cloudflare → Security → **Under Attack Mode** 사용법 숙지 (긴급 시 5초 challenge)
- [ ] DB backup 매주 restore test (자동화 가능)
- [ ] Cloudflare → Rules → **Page Rules** OR **Configuration Rules**:
  - `coolify.fina.app/*` → Security Level: High
  - `api.fina.app/*` → Security Level: Medium (webhook false positive 피함)
- [ ] Cloudflare → SSL/TLS → **Authenticated Origin Pulls** 활성화 — Origin 이 Cloudflare 가 보낸 request 인지 검증 (mTLS). 추가 보안 layer.
- [ ] Sentry/Logflare error tracking
- [ ] Rate limiting at Cloudflare layer:
  - Free plan: 10k requests/month rule 1개 무료
  - Webhook 외 일반 API 에 적용 (예: `/auth/sign-in` 10 req/min/IP)

---

## 21. 비용 monthly

- Hetzner CX22: $5
- Backblaze B2: ~$0.50 (backup 만)
- Cloudflare: $0 (Free plan)
- 도메인: ~$1 amortized
- **합계: ~$6.50/월**

성장 단계:
- 사용자 100+: Sentry $26 + Cloudflare Pro $25 = +$51 (선택)
- 사용자 1000+: Neon DB $19 + Better Stack pro $25 + Cloudflare Pro $25 = +$69
- 사용자 5000+: 별도 architecture re-eval

---

## 22. Disaster recovery (전체 VPS 죽음)

1. Hetzner 신규 CX22 provision (5분)
2. SSH hardening + ufw + CF IP allowlist (§4, 20분)
3. Coolify install (§5, 10분)
4. Origin Cert paste (§6.2, 5분)
5. Cloudflare DNS A record 새 IP 로 (DNS proxy ON 이라 propagation 빠름, ~1분)
6. Coolify UI 에서 fina project 만들기, GitHub 재연결 (5분)
7. Postgres restore from B2 backup (§13.3 절차)
8. fina-api Application redeploy (5분)

**총 ~1시간**. Cloudflare DNS proxy 가 propagation 시간 거의 0 으로 만들어줌.

---

## 끝

이 가이드대로 하면 처음부터 Cloudflare-protected production. Origin IP 노출 없음, DDoS 자동 차단, Coolify UI 는 OAuth 만 통과한 사람만, Plaid/Stripe webhook 정상 동작.

다음 단계 (코드 쪽):
1. `apps/api/Dockerfile.prod` 작성 + 로컬 검증
2. `/healthz` 엔드포인트 코드 확인
3. Graceful shutdown (SIGTERM 처리 — Fastify 기본 제공)
4. Hetzner 계정 만들고 §1.1 시작
