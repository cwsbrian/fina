# Fina — Pre-Launch Checklist

생성: 2026-05-25

이 파일은 production 배포 전 user-action 필요 항목 + 추천 검증 순서 정리.

---

## 1. Mobile / Expo (TestFlight 직전)

- [x] **EAS projectId 설정** — `apps/mobile/app.json:extra.eas.projectId` = `bdfb302d-2a78-422b-bcd4-5e69ba0a7b03` ✓ (memory의 "REPLACE_WITH_EAS_PROJECT_ID" stale)
- [ ] **Apple Developer / Google Play 등록** — EAS Submit 사용 가능하도록 credentials 등록
- [ ] **`eas build --profile production`** — production binary 생성
- [ ] **TestFlight 베타 배포** — 자체 device 에서 실제 push 수신 확인

## 2. Production env vars

배포 호스트 (Railway/Fly/Render 등) 에 다음 env 설정 필요. Local `.env` 는 dev 용으로만 `DATABASE_URL` 보유.

### Required (from `apps/api/src/env.ts`)
- [ ] `DATABASE_URL` — production Postgres
- [ ] `BETTER_AUTH_SECRET` — min 32 chars, 무작위 생성 (`openssl rand -base64 32`)
- [ ] `BETTER_AUTH_URL` — production API URL (e.g., `https://api.withfina.com`)
- [ ] `WEB_APP_URL` — production web URL (e.g., `https://withfina.com`)
- [ ] `STRIPE_SECRET_KEY` — production sk_live_*
- [ ] `STRIPE_WEBHOOK_SECRET` — production whsec_*
- [ ] `STRIPE_PRICE_PRO_MONTHLY` — production price ID
- [ ] `STRIPE_PRICE_MAX_MONTHLY` — production price ID
- [ ] `PLAID_CLIENT_ID` — production
- [ ] `PLAID_SECRET` — production secret
- [ ] `PLAID_ENV` — `production` (test에서는 `sandbox`)
- [ ] `ENCRYPTION_KEY` — 32-byte base64, AES-GCM key for Plaid token storage
- [ ] `GEMINI_API_KEY` — Google Gemini production key

### Optional but recommended
- [ ] `EXPO_ACCESS_TOKEN` — Expo Push rate limit 완화 + receipt polling 활성화. `https://expo.dev/accounts/[account]/settings/access-tokens` 발급
- [ ] `EMAIL_FROM` — sender address (default `Fina <no-reply@buildingintent.com>`)
- [ ] `RESEND_API_KEY` — invite email + 기타 transactional. 없으면 silent no-op.

## 3. 데이터베이스 마이그레이션

- [ ] **`pnpm --filter @fina/api exec prisma migrate deploy`** — production DB 에 마이그레이션 적용
- [ ] **마이그레이션 dry-run** — staging DB 에서 먼저 시도 (data loss / lock duration 확인)
- [ ] **Backup** — 첫 배포 전 production DB snapshot

## 4. Webhook 등록

- [ ] **Plaid webhook URL** — production API에 `POST /plaid/webhook` 노출. Plaid 대시보드에서 webhook URL 등록.
- [ ] **Stripe webhook URL** — production API 의 `POST /stripe/webhook` 등록. Webhook signing secret 발급 후 env 에 반영.

## 5. Cron / Scheduler

API 서버는 in-process croner 사용 (`apps/api/src/cron/scheduler.ts`). 배포 호스트가 single-instance 인지 확인 — multi-instance 환경이면 cron 중복 실행 발생.

- [ ] Single-instance 배포 보장 OR
- [ ] Distributed lock (Redis 등) 추가 (현재 미구현, 후속 plan 후보)

## 6. 코드 검증 (pre-launch sweep)

- [ ] **`/ultrareview`** — 전체 main branch 멀티-에이전트 cloud review. User-triggered slash command. 첫 production push 전 강력 권장.
- [ ] **`pnpm -F @fina/api test`** — full API suite green 확인
- [ ] **`pnpm -F @fina/web build`** — web 빌드 성공
- [ ] **`pnpm -F @fina/mobile typecheck`** — mobile typecheck (Expo Router 호환성)

## 7. Memory / 문서 정리

- [x] EAS projectId memory 항목 stale — 다음 commit 에서 업데이트 권장
- [ ] 첫 production user 가입 후 [[project_chat_user_scope]] memory 의 "pre-launch destructive migration" 라인 archive 필요

---

## 빠른 액션 (오늘 가능)

1. EXPO_ACCESS_TOKEN 발급 (5분, expo.dev)
2. Plaid prod credentials 신청 (Plaid 승인 1-3일 소요)
3. Stripe prod 활성화 (계정 verification 필요)
4. `/ultrareview` 1회 실행 (cloud, billed)

## 보류 (별도 plan)

- Multi-instance cron locking (in-process croner → distributed scheduler)
- Mobile in-app purchase 통합 (현재 web Stripe Checkout 만)
- Email template 디자인 (`@fina/email` 패키지 후보)
