# IAP launch smoke — sandbox cutover gate

Gate the four launch checks from spec §11 before flipping `APPLE_ENV=production` / Google Play track to "production".

## Gate 1 — ASSN V2 endpoint set before first purchase

- [ ] In ASC, paste `https://api.fina.app/webhooks/iap/apple` into both Production Server URL AND Sandbox Server URL under App Information → App Store Server Notifications.
- [ ] Confirm "Version 2" is selected.
- [ ] Apple does NOT back-fill historical notifications — anything before this paste is lost forever.

## Gate 2 — iOS round-trip

- [ ] Launch dev-client build on a device with a sandbox tester signed in.
- [ ] `/plan` picker renders both products with localized prices.
- [ ] Tap pro_monthly Subscribe → StoreKit prompt → confirm.
- [ ] Within 5 seconds: API logs `POST /billing/iap/checkout` 200 with `tier: pro`.
- [ ] Within 60 seconds: API logs ASSN webhook with `notificationType: SUBSCRIBED` and `WebhookEvent` row exists.
- [ ] DB: `Subscription` row exists with `source=iap_apple`, `tier=pro`, `environment=Sandbox`, `status=active`.
- [ ] DB: `User.iapAppleAccountToken` is set to `uuidv5(userId, IAP_NAMESPACE)`.

## Gate 3 — Android acknowledge round-trip

- [ ] Launch dev-client build on an Android device with the Google account added to Play license-testers.
- [ ] Subscribe lite_monthly.
- [ ] Within 5 seconds: `POST /billing/iap/checkout` 200.
- [ ] Within 5 minutes: API calls `purchases.subscriptions.acknowledge(packageName, subscriptionId=productId, token)` for the new sub. Verify by directly re-fetching the purchase via `purchases.subscriptionsv2.get` (gcloud CLI or googleapis quickstart) and confirming `acknowledgementState === ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED`. (No custom log line — the call lives inside `google-client.ts._acknowledge` and surfaces only errors.)
- [ ] Pub/Sub: subsequent RTDN notifications dedup correctly (no duplicate `Subscription` rows).

## Gate 4 — Force-cancel reflection (both platforms)

- [ ] On iOS: Settings → [App Store] → Sandbox → cancel the test subscription. Within 60 seconds, API webhook receives `DID_CHANGE_RENEWAL_STATUS` and `Subscription.cancelAtPeriodEnd` flips to true.
- [ ] On Android: Play Store → Subscriptions → cancel. Within 60 seconds, RTDN delivers SUBSCRIPTION_CANCELED → `Subscription.cancelAtPeriodEnd=true`, `status=active` (still in current period).
- [ ] After the sandbox-accelerated period ends (~5 min on iOS sandbox), confirm webhook flips to `EXPIRED` → `Subscription.status=canceled`.

## Production cutover

Only after all four gates pass:
- [ ] Set `APPLE_APP_APPLE_ID` in Vercel env (numeric App Apple ID from App Store Connect → App Information → General → "Apple ID"). REQUIRED in production — `requireIapEnv` throws 503 otherwise. The Apple SDK validates this value against every ASSN V2 notification payload.
- [ ] Flip Vercel env: `APPLE_ENV=production`.
- [ ] Confirm `Subscription.environment` filter rejects any lingering Sandbox rows from grants in production `/me`.
- [ ] Update App Store Connect product status to Ready for Sale.
- [ ] Update Play Console subscriptions to Active.
- [ ] Tag release: `git tag v1-iap-launch && git push --tags`.
