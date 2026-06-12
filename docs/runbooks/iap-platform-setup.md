# IAP 플랫폼 설정 Runbook

Last updated: 2026-06-11

이 문서는 Fina 모바일 IAP를 다시 설정할 때 보는 짧은 기준 문서다. 결제 검증 API, Apple App Store Server Notifications, Google Play RTDN/Pub/Sub 설정을 한 곳에 모았다.

## 현재 Fina 값

앱 식별자:

```text
iOS Bundle ID: com.withfina.app
Android package name: com.withfina.app
```

현재 코드가 인식하는 상품 ID:

```text
iOS Pro: fina_pro_monthly
iOS Max: max_monthly
Android Pro: pro_monthly
Android Max: max_monthly
```

API webhook 경로:

```text
Apple:  /webhooks/iap/apple
Google: /webhooks/iap/google
```

현재 로컬 테스트용 Tailscale Funnel:

```text
https://brians-mac-mini.tail49be41.ts.net
```

현재 Google Cloud project:

```text
Project ID: gen-lang-client-0527026210
Project number: 287347024529
RTDN topic: projects/gen-lang-client-0527026210/topics/iap-rtdn
Local/test push subscription: projects/gen-lang-client-0527026210/subscriptions/iap-rtdn-push
```

## 서버 env

Apple IAP:

```env
APPLE_BUNDLE_ID=com.withfina.app
APPLE_APP_APPLE_ID=<numeric App Store Connect Apple ID; production required>
APPLE_ASC_ISSUER_ID=<App Store Connect API issuer UUID>
APPLE_ASC_KEY_ID=<App Store Connect API key ID>
APPLE_ASC_PRIVATE_KEY=<.p8 contents, escaped PEM, or base64 PEM>
APPLE_ENV=sandbox
```

Google IAP receipt validation:

```env
GOOGLE_PACKAGE_NAME=com.withfina.app
GOOGLE_SERVICE_ACCOUNT_JSON=<service account JSON, raw JSON or base64 JSON>
```

Google RTDN webhook:

```env
GOOGLE_PUBSUB_VERIFY_AUDIENCE=https://<api-domain>/webhooks/iap/google
GOOGLE_PUBSUB_VERIFY_EMAIL=<push OIDC service account email>
GOOGLE_PUBSUB_SUBSCRIPTION_NAME=projects/<project-id>/subscriptions/<subscription-id>
```

For current local Funnel testing:

```env
GOOGLE_PUBSUB_VERIFY_AUDIENCE=https://brians-mac-mini.tail49be41.ts.net/webhooks/iap/google
GOOGLE_PUBSUB_VERIFY_EMAIL=fina-play-iap-validator@gen-lang-client-0527026210.iam.gserviceaccount.com
GOOGLE_PUBSUB_SUBSCRIPTION_NAME=projects/gen-lang-client-0527026210/subscriptions/iap-rtdn-push
```

Production must use the production API domain instead of the Tailscale URL:

```env
GOOGLE_PUBSUB_VERIFY_AUDIENCE=https://<production-api-domain>/webhooks/iap/google
```

## Google Play / Pub/Sub setup

Google has two separate pieces:

- Play Developer API service account: used by our server to verify purchases and acknowledge subscriptions.
- Pub/Sub RTDN: used by Google Play to push renewal/cancel/expire notifications to our webhook.

### 1. Play Developer API

Google Play Console:

```text
설정 -> API 액세스
```

Use or create a service account. Download the JSON key and put it into `GOOGLE_SERVICE_ACCOUNT_JSON`. The same JSON can be pasted as raw JSON or base64-encoded JSON.

Grant the service account enough Play Console permissions to read subscription purchase state and acknowledge purchases.

### 2. Cloud Pub/Sub topic

Google Cloud Console:

```text
Pub/Sub -> 주제 -> 주제 만들기
```

Use:

```text
주제 ID: iap-rtdn
```

Leave optional features off unless needed:

```text
기본 구독 추가: off
스키마 사용: off
메시지 보관 사용: off
BigQuery export: off
Cloud Storage backup: off
암호화: Google 관리 암호화 키
```

On the topic permissions, add Google Play as publisher:

```text
Principal: google-play-developer-notifications@system.gserviceaccount.com
Role: Pub/Sub 게시자
```

Official Google docs require this publisher grant.

### 3. Push subscription

Google Cloud Console:

```text
Pub/Sub -> 구독 -> 구독 만들기
```

Local test subscription:

```text
구독 ID: iap-rtdn-push
주제: iap-rtdn
전송 유형: 푸시
엔드포인트 URL: https://brians-mac-mini.tail49be41.ts.net/webhooks/iap/google
인증 사용: on
서비스 계정: fina-play-iap-validator@gen-lang-client-0527026210.iam.gserviceaccount.com
대상 / Audience: https://brians-mac-mini.tail49be41.ts.net/webhooks/iap/google
```

Production subscription should use a separate subscription and the production API URL:

```text
구독 ID: iap-rtdn-prod-push
엔드포인트 URL: https://<production-api-domain>/webhooks/iap/google
대상 / Audience: https://<production-api-domain>/webhooks/iap/google
```

If Google Cloud says the Pub/Sub service agent cannot mint tokens, grant:

```text
Principal: service-287347024529@gcp-sa-pubsub.iam.gserviceaccount.com
Role: 서비스 계정 토큰 생성자
```

### 4. Play Console RTDN

Google Play Console:

```text
앱 선택 -> 수익 창출 -> 수익 창출 설정 -> 실시간 개발자 알림
```

Topic name:

```text
projects/gen-lang-client-0527026210/topics/iap-rtdn
```

Then click:

```text
테스트 알림 보내기
```

Expected local result:

```text
API log: POST /webhooks/iap/google -> 200
DB: webhook_events row with source=iap_google
```

Useful DB check:

```sql
SELECT id, source, type, "receivedAt"
FROM webhook_events
WHERE source = 'iap_google'
ORDER BY "receivedAt" DESC
LIMIT 10;
```

Important implementation note: Pub/Sub OIDC JWT `email` must match `GOOGLE_PUBSUB_VERIFY_EMAIL`, and `aud` must match `GOOGLE_PUBSUB_VERIFY_AUDIENCE`. Do not require `azp` to equal the email; Google documents `azp` as a numeric authorized-party ID.

## Apple App Store setup

Apple also has two separate pieces:

- App Store Connect API key: used by our server to verify transactions and decode notifications.
- App Store Server Notifications V2: Apple's webhook for renew/cancel/expire/refund events.

### 1. App Store Connect API key

App Store Connect:

```text
사용자 및 액세스 -> 키
```

Create an App Store Connect API key and save:

```text
Issuer ID -> APPLE_ASC_ISSUER_ID
Key ID -> APPLE_ASC_KEY_ID
.p8 file contents -> APPLE_ASC_PRIVATE_KEY
```

The `.p8` file can only be downloaded once. Store it in the password manager. Do not commit it.

Production also requires:

```text
APPLE_APP_APPLE_ID=<numeric Apple ID from App Store Connect App Information>
```

### 2. App Store Server Notifications V2

This is the Apple equivalent of Google's webhook. If this is not configured, iOS purchases can still be verified during checkout/restore, but renewals, cancellations, expirations, refunds, and billing changes will not automatically reach the backend by webhook.

App Store Connect:

```text
앱 선택 -> 일반 -> 앱 정보 -> App Store Server Notifications
```

Set both URLs when possible:

```text
Production Server URL: https://<production-api-domain>/webhooks/iap/apple
Sandbox Server URL: https://<local-or-production-api-domain>/webhooks/iap/apple
Version: Version 2
```

For local Funnel testing:

```text
Sandbox Server URL: https://brians-mac-mini.tail49be41.ts.net/webhooks/iap/apple
Version: Version 2
```

For production:

```text
Production Server URL: https://<production-api-domain>/webhooks/iap/apple
Sandbox Server URL: https://<production-api-domain>/webhooks/iap/apple
Version: Version 2
```

Apple's App Store Connect help says production and sandbox URLs can be configured separately. If no Sandbox URL is provided, sandbox notifications go to the Production URL. If only a Sandbox URL is provided, production notifications are not sent.

### 3. Apple test notification

Apple test notification is not a simple console button in the same way Google Play RTDN is. Use the App Store Server API "Request a Test Notification" endpoint, or perform a sandbox purchase/cancel and watch:

```text
API log: POST /webhooks/iap/apple -> 200
DB: webhook_events row with source=iap_apple
```

Useful DB check:

```sql
SELECT id, source, type, "receivedAt"
FROM webhook_events
WHERE source = 'iap_apple'
ORDER BY "receivedAt" DESC
LIMIT 10;
```

## Local webhook test flow

Start local API:

```bash
DATABASE_URL=postgresql://fina:fina@localhost:5433/fina \
WEB_APP_URL=http://192.168.30.164:3100 \
DEV_ORIGINS=http://192.168.30.164:3100 \
APPLE_ENV=sandbox \
CRON_ENABLED=false \
DOTENV_CONFIG_PATH=../../.env \
pnpm --filter @fina/api exec tsx -r dotenv/config src/main.ts
```

Start Tailscale Funnel:

```bash
tailscale funnel --bg --yes 4000
tailscale funnel status
```

Health check:

```bash
curl https://brians-mac-mini.tail49be41.ts.net/health
```

Expected:

```json
{"status":"ok","checks":{"db":"ok"}}
```

## Production checklist

Before shipping production IAP:

- Production API has all Apple and Google env vars.
- `APPLE_ENV=production`.
- `APPLE_APP_APPLE_ID` is set.
- App Store Connect Production Server URL points to production `/webhooks/iap/apple`.
- App Store Connect notification version is V2.
- Google Pub/Sub production push subscription endpoint points to production `/webhooks/iap/google`.
- Google Pub/Sub production push subscription audience exactly equals the endpoint URL.
- `GOOGLE_PUBSUB_VERIFY_AUDIENCE` exactly equals the production audience.
- `GOOGLE_PUBSUB_VERIFY_EMAIL` equals the OIDC service account selected on the push subscription.
- `GOOGLE_PUBSUB_SUBSCRIPTION_NAME` equals the full production subscription name.
- Play Console RTDN topic is `projects/gen-lang-client-0527026210/topics/iap-rtdn`.
- Play Console "테스트 알림 보내기" returns a server 2xx and creates a `webhook_events` row.

## What still works without webhooks?

Checkout and restore still work because the app sends receipts directly to:

```text
POST /billing/iap/checkout
POST /billing/iap/restore
```

The server validates those receipts with Apple/Google and updates `subscriptions`.

What webhooks add:

- Auto-renewal state updates when the app is closed.
- Cancellation/refund/expiration updates without waiting for the user to open the app.
- Faster entitlement correction after store-side changes.

So Apple without App Store Server Notifications is not fatal for purchase testing, but it is not complete for production subscription lifecycle handling.

## References

- Apple: Enter server URLs for App Store Server Notifications: https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications/
- Apple: App Store Server Notifications V2: https://developer.apple.com/documentation/AppStoreServerNotifications/App-Store-Server-Notifications-V2
- Apple: Request a Test Notification: https://developer.apple.com/documentation/appstoreserverapi/request-a-test-notification
- Google: Play Billing RTDN setup: https://developer.android.com/google/play/billing/getting-ready#configure-rtdn
- Google: RTDN reference: https://developer.android.com/google/play/billing/rtdn-reference
- Google Cloud: Authenticated Pub/Sub push subscriptions: https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
