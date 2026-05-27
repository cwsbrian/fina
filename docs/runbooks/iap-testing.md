# IAP 테스트 가이드 — 처음부터 끝까지

Mobile In-App Purchase (Apple StoreKit 2 + Google Play Billing) 를 sandbox 에서 end-to-end 로 돌려보는 절차. 처음 한 번 setup 한 다음에는 daily 테스트는 §7 부터 만 보면 됨.

**주요 코드 파일 위치:**
- API IAP 코드: `apps/api/src/iap/*.ts`, `apps/api/src/routes/billing-iap*.ts`
- Mobile IAP 코드: `apps/mobile/src/iap/*.ts`, `apps/mobile/app/plan/*.tsx`
- Spec: `docs/superpowers/specs/2026-05-26-mobile-iap-billing-design.md`
- Launch gates checklist: `docs/smoke/2026-05-26-iap-launch.md`

---

## 1. 한 번만 하는 setup

### 1.1 Apple — App Store Connect

1. **Apple Developer 계정 + paid membership** ($99/year).
2. **App 등록**: App Store Connect → My Apps → "+" → New App. Bundle ID 는 `apps/mobile/app.json` 의 `expo.ios.bundleIdentifier` 와 일치 (예: `com.withfina.app`). 등록 후 numeric "Apple ID" 발급됨 → production 필수 `APPLE_APP_APPLE_ID`.
3. **Subscription products 생성** (Monetization → Subscriptions):
   - Subscription group: "Fina"
   - Sub 1: Reference Name "Lite Monthly", **Product ID `lite_monthly`** (정확히 이 문자열), 1 Month, ~$6.99 CAD
   - Sub 2: "Pro Monthly", **`pro_monthly`**, 1 Month, ~$14.99 CAD
   - Status 가 "Ready to Submit" 이상이어야 sandbox 에 보임.
4. **ASC API key** 발급 (Users and Access → Keys → "+"):
   - Role: Admin
   - .p8 파일 다운로드 (한 번만 받을 수 있음)
   - Issuer ID, Key ID 메모
5. **App Store Server Notifications V2** 설정 (App Information → App Store Server Notifications):
   - Production Server URL: `https://api.withfina.com/webhooks/iap/apple`
   - Sandbox Server URL: same (또는 Tailscale Funnel URL — §1.4)
   - Version: V2
   - **첫 sandbox 구매 전에 반드시 설정** — Apple 은 historical notification 안 back-fill.
6. **Sandbox tester** 생성 (Users and Access → Sandbox → Testers → "+"):
   - 본인 Apple ID 와 다른 email
   - Region 선택
   - **한 device 에 한 sandbox tester** 만 — 매번 sign out 해야 변경됨

### 1.2 Google — Play Console

1. **Google Play Console** account ($25 one-time).
2. **App 등록**: All apps → Create app. Package name 은 `apps/mobile/app.json` 의 `expo.android.package` 와 일치.
3. **Internal testing track**: Testing → Internal testing → Create new release. 첫 빌드 upload + roll out 하면 sandbox 에서 product 보임.
4. **Subscription products**: Monetize → Products → Subscriptions:
   - Same Product IDs: `lite_monthly`, `pro_monthly`
   - Base plan monthly, ~$6.99 / ~$14.99 CAD
   - Status: Active
5. **Service account** (Setup → API access):
   - Google Cloud project link (또는 생성)
   - Service account + JSON key
   - 권한: **`androidpublisher.subscriptions.get` AND `.update`** (acknowledge 에 update 필수)
   - JSON → base64: `base64 -w0 service-account.json` → `GOOGLE_SERVICE_ACCOUNT_JSON` env (Vercel 4KB cap 대응)
6. **RTDN 설정**:
   - GCP → Pub/Sub → Topics → Create: `fina-iap-rtdn`
   - Push subscription:
     - Endpoint: `https://api.withfina.com/webhooks/iap/google`
     - Authentication: enable, audience = endpoint URL 그대로
   - Subscription name 메모 → `GOOGLE_PUBSUB_SUBSCRIPTION_NAME` (예: `projects/fina-prod/subscriptions/fina-iap-rtdn-push`)
   - Play Console → Monetize → Monetization setup → Topic name `projects/fina-prod/topics/fina-iap-rtdn` paste + Save
7. **License tester** (Setup → License testing → Email addresses): 테스트할 Google account 추가. RESPOND_NORMALLY.
8. **Internal tester** (Internal testing → Testers tab): account 추가 + opt-in link 클릭

### 1.3 EAS / dev client

1. `pnpm dlx eas-cli@latest login`
2. `apps/mobile/eas.json` 에 `development` profile 확인:
   ```json
   {
     "build": {
       "development": {
         "developmentClient": true,
         "distribution": "internal",
         "ios": { "simulator": false },
         "android": { "buildType": "apk" }
       }
     }
   }
   ```
3. iOS credentials prompt 나오면 EAS 가 자동 처리 — 'Y'.

### 1.4 Tailscale Funnel (webhook 받기)

Dev 머신을 public URL 로 expose:

```bash
sudo tailscale funnel 4000
# 출력 URL 메모, e.g. https://your-tailnet.ts.net/
```

이 URL 을:
- ASC ASSN V2 endpoint (Sandbox URL)
- Google Pub/Sub push subscription endpoint
에 임시 paste. **Production launch 시에는 진짜 production URL 로 되돌릴 것.**

### 1.5 Env vars

`apps/api/.env.local` (dev) 또는 Vercel project env (prod):

```bash
# Apple
APPLE_BUNDLE_ID=com.withfina.app
APPLE_APP_APPLE_ID=1234567890                 # ASC 의 numeric Apple ID
APPLE_ASC_ISSUER_ID=<UUID from ASC>
APPLE_ASC_KEY_ID=<key ID from ASC>
APPLE_ASC_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
...paste .p8 contents...
-----END PRIVATE KEY-----"
# 또는: cat AuthKey_XXX.p8 | base64 -w0
APPLE_ENV=sandbox                              # sandbox | production

# Google
GOOGLE_PACKAGE_NAME=com.withfina.app
GOOGLE_SERVICE_ACCOUNT_JSON=<base64 of service-account.json>
GOOGLE_PUBSUB_VERIFY_AUDIENCE=https://api.withfina.com/webhooks/iap/google
GOOGLE_PUBSUB_VERIFY_EMAIL=<service account email>
GOOGLE_PUBSUB_SUBSCRIPTION_NAME=projects/fina-prod/subscriptions/fina-iap-rtdn-push
```

**중요:** `APPLE_ENV` 가 JWS 의 `environment` claim 과 일치해야 함. Sandbox JWS 가 production env 로 들어오면 reject (spec §5.2 check #4 — "free Pro" exploit 방어).

---

## 2. Dev client 빌드 (개발자당 한 번)

`react-native-iap` 는 native module → Expo Go 에서 안 됨.

```bash
cd apps/mobile

# iOS
eas build --profile development --platform ios
# 빌드 15-30분, 끝나면 EAS dashboard 에 install link

# Android
eas build --profile development --platform android
# .apk link
```

설치:
- **iOS**: Safari 로 link 열고 install. 설정 → 일반 → VPN 및 기기 관리 에서 신뢰.
- **Android**: link → .apk 다운로드 → install (unknown sources 허용).

빌드는 한 번 하면 다음 setup 까지 재사용. JS 코드 변경은 Metro 로 OTA reload.

---

## 3. Local dev 환경

### 3.1 API + DB

```bash
docker compose up -d postgres
pnpm --filter @fina/api exec prisma migrate deploy
pnpm --filter @fina/api dev
# :4000 에서 listening
```

### 3.2 Tailscale Funnel (webhook 받을 때만)

```bash
sudo tailscale funnel 4000
```

### 3.3 Expo (Metro)

```bash
pnpm run smoke:mobile:lan
# REACT_NATIVE_PACKAGER_HOSTNAME=100.65.93.102, :8081
```

폰 dev client 앱 → URL 직접 입력 `exp://100.65.93.102:8081`

---

## 4. iOS sandbox 구매 — full round-trip

### 4.1 폰 준비

1. Settings → Apple Account → Media & Purchases → Sign Out
2. 여기서 다시 sign in 하지 말 것. 앱 안에서 구매 시도 시 sandbox prompt 가 뜸.

### 4.2 앱 실행 → /plan

1. Dev client 앱 열어서 Metro 연결
2. Fina account 로 sign-in
3. More → "Plan" tap (free / trial 이면 `/plan` 로 이동)
4. 또는 `exp://100.65.93.102:8081/--/plan`

### 4.3 구매

- Picker 에 두 product 카드 (Lite/Pro) + localized price
- "Pro" tap → StoreKit native dialog
- Sign-out 직후라면 sandbox tester credential 입력 (1.1.6 의 계정)
- Confirm → "Environment: Sandbox" 보이면 OK

### 4.4 확인

**API 로그**: `POST /billing/iap/checkout 200` (~2-5초)

**DB**:
```sql
SELECT "userId", tier, source, "sourceSubscriptionId", environment, status, "currentPeriodEnd"
FROM subscriptions WHERE source = 'iap_apple' ORDER BY "createdAt" DESC LIMIT 1;
-- 기대: tier=pro, source=iap_apple, environment=Sandbox, status=active

SELECT id, "iapAppleAccountToken" FROM users WHERE id = '<your userId>';
-- 기대: iapAppleAccountToken set (uuidv5)
```

**Webhook** (1분 이내):
```sql
SELECT id, source, type, "receivedAt" FROM webhook_events
WHERE source = 'iap_apple' ORDER BY "receivedAt" DESC LIMIT 5;
-- 기대: type='SUBSCRIBED' or 'DID_RENEW'
```

**UI**: 자동 redirect to `/(tabs)`. More 의 Plan 이 "Pro" 로. Manage billing → Apple Settings deep-link.

### 4.5 Sandbox 시간 가속

iOS sandbox: 1-month sub = **5분**. Auto-renew 도 5분마다 (최대 6회). Cancellation/renewal webhook 테스트하기 편함.

---

## 5. Android sandbox 구매 — full round-trip

### 5.1 폰 준비

- License tester 로 등록된 Google account 로 sign-in
- Play Store 가 internal testing track 빌드 보고 있어야 함

### 5.2 앱 → /plan

iOS 와 동일.

### 5.3 구매

- "Subscribe" tap → Play Billing dialog → "This is a test purchase"
- Confirm → 결제 안 됨 (license tester)

### 5.4 확인

```sql
SELECT "userId", tier, source, "sourceSubscriptionId", environment, status
FROM subscriptions WHERE source = 'iap_google' ORDER BY "createdAt" DESC LIMIT 1;
-- 기대: source=iap_google, environment=Sandbox (raw.testPurchase 있어서)
```

### 5.5 Acknowledge 확인

3일 안에 ack 안 하면 Google 자동 환불. 우리 코드는 upsert 직후 ack 호출 (`sync-sub.ts:153`). 확인:

```bash
gcloud auth activate-service-account --key-file=service-account.json
ACCESS_TOKEN=$(gcloud auth print-access-token)
PT="<purchaseToken from subscriptions.sourceSubscriptionId>"
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.withfina.app/purchases/subscriptionsv2/tokens/$PT" \
  | jq '.acknowledgementState'
# 기대: "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED"
```

### 5.6 RTDN

```sql
SELECT id, source, type, "receivedAt" FROM webhook_events
WHERE source = 'iap_google' ORDER BY "receivedAt" DESC LIMIT 5;
-- 기대: type='notif_4' (SUBSCRIPTION_PURCHASED)
```

Android sandbox: 1-month = ~30분.

---

## 6. 시나리오별 테스트

### 6.1 Restore (재설치 / 새 device)

1. 앱 uninstall → reinstall
2. 같은 Fina account 로 sign-in
3. More → "Restore purchases" 또는 `/plan/restore`
4. 버튼 tap
5. 확인: `POST /billing/iap/restore 200`, 화면에 "Restored — tier: pro"

### 6.2 Cancellation (cancel-at-period-end)

**iOS**: Settings → Apple ID → Subscriptions → Fina → Cancel → 1분 이내 ASSN → `Subscription.cancelAtPeriodEnd=true`

**Android**: Play Store → Subscriptions → Fina → Cancel → 1분 이내 RTDN → 같은 update

```sql
SELECT "cancelAtPeriodEnd", status, "currentPeriodEnd" FROM subscriptions
WHERE "userId" = '<id>' AND source LIKE 'iap_%';
```

### 6.3 Expiration

- iOS sandbox: cancel 후 ~5분 더 기다림 → `DID_EXPIRE` → status="canceled"
- Android: ~30분 → EXPIRED

### 6.4 Cross-source — Stripe + IAP

1. Web 에서 Stripe checkout (Lite)
2. Mobile 에서 IAP Pro 구매
3. DB:
```sql
SELECT source, tier, status FROM subscriptions WHERE "userId" = '<id>';
-- 기대: stripe/lite/active + iap_apple/pro/active
```
4. `GET /me` → `subscription.source = "stripe"` (Stripe-always-wins precedence)
5. More → Manage billing → Stripe Portal (Apple Settings 아님)

### 6.5 Account deletion tombstone (manual)

v1 에 self-service deletion 없으니 직접:

```sql
-- 1. tombstone write
INSERT INTO iap_deleted_bindings (id, source, "tokenHash", "userIdHash", "deletedAt")
SELECT 'tmb1', 'iap_apple',
       encode(digest("iapAppleAccountToken", 'sha256'), 'hex'),
       encode(digest(id, 'sha256'), 'hex'),
       now()
FROM users WHERE id = '<id>';

-- 2. binding 지움
UPDATE users SET "iapAppleAccountToken" = NULL WHERE id = '<id>';
```

이후 renewal ASSN → step 3 (tombstone) hit → 200 + `unattributable_after_delete` event.

---

## 7. Daily testing checklist (setup 끝난 후)

```bash
docker compose up -d postgres
sudo tailscale funnel 4000 &
pnpm --filter @fina/api dev &
pnpm run smoke:mobile:lan
```

폰 dev client 열고:
- [ ] `/plan` 가 두 product 보여줌
- [ ] Sandbox tester (iOS) / license tester (Android) 로 sign-in
- [ ] 구매 → 5초 안에 checkout 200, DB row
- [ ] 1분 안에 webhook 도착, `webhook_events` row
- [ ] `/me` 에 tier 반영

문제 시 §8.

---

## 8. Troubleshooting

### "Subscriptions aren't available right now"

`fetchProducts` 가 [] 반환:
- **Expo Go 에서 실행**: dev client 필요
- **ASC/Play Console product 가 "Ready" 가 아님**
- **Sandbox tester wrong region**: product available region 확인
- **Device 의 Apple ID 가 sandbox 가 아님**

### 503 `iap_not_configured`

- env var 미설정. API 로그 확인.
- production env 에서 `APPLE_APP_APPLE_ID` 누락

### 403 `user_mismatch`

`appAccountToken` mismatch:
- Mobile userId 와 session.userId 불일치 → sign-in 다시
- 다른 user 의 receipt 사용 (보안 방어)

### 400 `invalid_receipt` (Apple)

JWS 검증 실패:
- bundleId mismatch: `APPLE_BUNDLE_ID` 가 ASC 의 bundle 과 다름
- environment mismatch: `APPLE_ENV=production` 인데 sandbox JWS 또는 그 반대
- signedDate 너무 오래됨: device 시간 또는 10분/1시간 window
- root cert chain: `apple-roots.ts` PEM (module load 시 throw)

### 400 `invalid_receipt` (Google webhook)

OIDC verification 실패:
- `GOOGLE_PUBSUB_VERIFY_AUDIENCE` 가 push subscription audience 와 안 맞음
- `GOOGLE_PUBSUB_VERIFY_EMAIL` 이 OIDC token email 과 다름

### Google 3-day auto-refund

Acknowledge 발동 안 됨:
- API 로그에 acknowledge 에러
- service account 가 `.update` scope 가 있는지
- `_acknowledge` 호출 보이는지

### Webhook 안 옴

- `sudo tailscale funnel status`
- ASC Sandbox URL 이 funnel URL 과 일치하는지
- Pub/Sub push subscription endpoint 가 funnel URL 과 일치하는지
- Pub/Sub delivery type 이 Push 인지

### E_ALREADY_OWNED

이전 sandbox 구매가 active:
- iOS Settings → Subscriptions → Cancel + 5분 대기
- 또는 sandbox tester 새로 만들기 (한 device 한 tester)
- Android: Play Store → Subscriptions → Cancel

코드 측: `IapPurchaseError(E_ALREADY_OWNED)` 발생 시 plan picker 가 자동 `/plan/restore` navigate.

---

## 9. Reset / clean state

```sql
-- IAP state 전부 reset
DELETE FROM webhook_events WHERE source IN ('iap_apple', 'iap_google');
DELETE FROM subscriptions WHERE source IN ('iap_apple', 'iap_google');
DELETE FROM iap_deleted_bindings;
DELETE FROM iap_retry_counters;
UPDATE users SET "iapAppleAccountToken" = NULL, "iapGoogleObfuscatedId" = NULL;
```

iOS device sub reset:
- Settings → Apple ID → Subscriptions → Fina → Cancel → wait for expire
- 또는 sandbox tester 새로 만들기

Android device:
- Play Store → Profile → Payments & subscriptions → Subscriptions → Fina → Cancel

---

## 10. Production cutover

`docs/smoke/2026-05-26-iap-launch.md` 의 Gate 1-4 모두 통과 후:

1. Vercel env: `APPLE_ENV=production`
2. `APPLE_APP_APPLE_ID` set (production 에서 필수, 503 throw)
3. ASC product → "Ready for Sale"
4. Play Console subscription → Active
5. ASC ASSN V2 Production URL 이 실제 production URL (Tailscale 아님)
6. Google Pub/Sub push subscription URL → production
7. `git tag v1-iap-launch && git push --tags`
8. App Store / Play Store submission

production switch 후 sandbox 테스트 안 됨 (env mismatch). 다시 테스트하려면 `APPLE_ENV=sandbox` 로 일시 변경.

---

## 부록 — 유용한 SQL queries

```sql
-- 내 IAP 구독 현황
SELECT s.tier, s.source, s.status, s.environment, s."currentPeriodEnd",
       s."cancelAtPeriodEnd"
FROM subscriptions s
JOIN users u ON u.id = s."userId"
WHERE u.email = '<my-email>' AND s.source LIKE 'iap_%';

-- 최근 webhook 활동
SELECT source, type, "receivedAt", body
FROM webhook_events WHERE source LIKE 'iap_%'
ORDER BY "receivedAt" DESC LIMIT 10;

-- 이상 신호 — retry counter 가 쌓이고 있다
SELECT source, "tokenHash", attempts, "lastAt"
FROM iap_retry_counters WHERE attempts >= 3;

-- 삭제된 user 의 binding tombstone
SELECT source, "deletedAt", "userIdHash"
FROM iap_deleted_bindings ORDER BY "deletedAt" DESC LIMIT 10;
```

```bash
# Apple ASC API 로 특정 sub 직접 조회 — JWT 가 필요해서 좀 더 복잡
# 보통 DB + webhook 로 충분함

# Google sub 의 raw state 조회
gcloud auth activate-service-account --key-file=service-account.json
ACCESS_TOKEN=$(gcloud auth print-access-token)
PT="<from subscriptions.sourceSubscriptionId>"
curl -s -H "Authorization: Bearer $ACCESS_TOKEN" \
  "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.withfina.app/purchases/subscriptionsv2/tokens/$PT" \
  | jq '{acknowledgementState, subscriptionState, lineItems: [.lineItems[] | {productId, expiryTime}]}'
```

---

## 참고 링크

- Apple StoreKit 2: https://developer.apple.com/documentation/storekit/in-app_purchase
- App Store Server API: https://developer.apple.com/documentation/appstoreserverapi
- ASSN V2: https://developer.apple.com/documentation/appstoreservernotifications
- Google Play Billing v6+: https://developer.android.com/google/play/billing
- RTDN: https://developer.android.com/google/play/billing/rtdn-reference
- Apple Certificate Authority: https://www.apple.com/certificateauthority/
