# SSO — Google · Apple (mobile + web) Design

**Date:** 2026-05-31
**Status:** Design (approved in brainstorming; revised after adversarial review; magic link deferred per user)
**Task:** #9 — wire up social sign-in (Google + Apple)

## Goal

Make the social sign-in controls work on **mobile and web**:
- **Google** — OAuth, on the sign-in and sign-up screens.
- **Apple** — **native** Sign in with Apple on iOS (App Store Guideline 4.8);
  **web OAuth** flow on web. Sign-in and sign-up screens.

Google + Apple are code-complete but inert until the operator supplies OAuth
credentials (documented at the end). Auth stays on Better Auth; DB (`Account`,
`Session`) and `trustedOrigins` (`fina://`) are already in place.

**Deferred (out of scope this round):** the passwordless **magic link** /
email-code button. The existing `<SocialButton provider="magic">` on the mobile
sign-in screen is **removed** here (it's a dead control); we'll revisit magic
link later. (Email-OTP *sign-up verification* is untouched — it already works.)

## Decisions (from brainstorming + review)

1. **Scope** — Google + Apple, on **both** sign-in & sign-up screens, mobile +
   web. Magic link deferred.
2. **Apple** — native (`expo-apple-authentication`) on iOS; web OAuth on web.
   iOS native needs a dev build (native module, like IAP). Hide the Apple button
   on Android and wherever `AppleAuthentication.isAvailableAsync()` is false.
3. **Credentials** — code-complete now; operator adds Google/Apple env later.

## Shared library touchpoints

**USES:** Better Auth (`better-auth` 1.6.11 installed) + `@better-auth/expo`.

**CREATES — a social-auth error union, NOT `ApiErrorCode`.** Social/OAuth
failures are **client-side Better Auth (BetterFetchError-shaped) results**, never
a REST `{error: code}` body through `apiFetch`/`isApiError`. New
`libs/shared/src/auth/social-errors.ts`:
```ts
export const SOCIAL_AUTH_ERRORS = ["oauth_failed", "oauth_cancelled", "apple_signin_unavailable"] as const;
export type SocialAuthError = (typeof SOCIAL_AUTH_ERRORS)[number];
/** Classify a Better Auth client error / thrown native result into a stable
 *  code both apps render identical copy for. */
export function classifySocialAuthError(e: unknown): SocialAuthError;
```
Exported from `libs/shared/src/index.ts`. Both apps call it → one source of
classification + copy (web↔mobile parity). **No new `ApiErrorCode`, no new DTOs.**

## Architecture

Register the Apple provider server-side (typed for its native option); wire the
Google + Apple button handlers on both apps; the only deep-link callback is the
Google/Apple **OAuth** redirect, handled inline by `@better-auth/expo`'s
`openAuthSessionAsync`. Account linking stays at Better Auth's safe default.

### Component 1 — Server (`apps/api/src/auth.ts`)

- Widen the `socialProviders` value type for Apple's native option:
  ```ts
  const socialProviders: Record<string, { clientId: string; clientSecret: string; appBundleIdentifier?: string }> = {};
  ```
- Add `apple` (alongside the existing conditional `google`):
  ```ts
  if (env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET) {
    socialProviders.apple = {
      clientId: env.APPLE_CLIENT_ID,          // Services ID — web flow audience
      clientSecret: env.APPLE_CLIENT_SECRET,   // .p8-derived JWT (static; see env note)
      appBundleIdentifier: "com.withfina.app", // native idToken audience
    };
  }
  ```
  (`appBundleIdentifier` is a valid `AppleOptions` field in the installed
  `@better-auth/core`.)
- **Account linking — safe default, NOT `trustedProviders`.** `trustedProviders`
  would make Better Auth *skip* the provider email-verified check (takeover
  risk). Use:
  ```ts
  account: { accountLinking: { enabled: true } }
  ```
  Default semantics (1.6.11 `oauth2/link-account.mjs`): link to a pre-existing
  user only when BOTH the provider `email_verified` is true AND the local account
  is verified (`requireLocalEmailVerified` default true) — the local-verified gate
  prevents takeover. Google ID tokens always carry `email_verified=true`; Apple
  is handled by the same gate.
- The existing `magicLink` + `emailOTP` plugins stay (used by sign-up
  verification / future magic link) — no change.

### Component 2 — Mobile (`apps/mobile`)

- **Client** (`src/auth/client.ts`): no change — `signIn.social` is core;
  `emailOTPClient` stays for sign-up verification.
- **Native deps** (dev build, like IAP): add `expo-apple-authentication`
  (+ its config plugin in `app.json` `plugins`) and `expo-crypto` (Apple nonce
  hash). Both absent today.
- **Extend `SocialButton`** (`src/design/AuthButtons.tsx`) to mirror `AuthCTA`:
  add `onPress`, `busy`, and a `hidden`/`disabled` path (OAuth + native calls are
  async; the Apple button must hide when unavailable). **Remove** the
  `provider="magic"` button from `sign-in.tsx` (deferred).
- **UI** (`app/(auth)/sign-in.tsx`, `sign-up.tsx`) — wire `onPress` on the
  Google + Apple buttons (present on both screens):
  - **Google** — `signIn.social({ provider: "google", callbackURL: Linking.createURL("/") })`.
    `@better-auth/expo` runs it through `WebBrowser.openAuthSessionAsync`, reads
    the `?cookie=` the server appends to the redirect, persists it to SecureStore
    → session. On success → `router.replace("/(tabs)")`.
  - **Apple** (iOS only — render only when `Platform.OS === "ios"` &&
    `await AppleAuthentication.isAvailableAsync()`). **Nonce lifecycle (required;
    Better Auth compares nonce by plain string, no re-hash):**
    ```ts
    const rawNonce = Crypto.randomUUID();
    const hashedNonce = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, rawNonce);
    const cred = await AppleAuthentication.signInAsync({ requestedScopes: [FULL_NAME, EMAIL], nonce: hashedNonce });
    await signIn.social({ provider: "apple", idToken: { token: cred.identityToken, nonce: hashedNonce } });
    ```
    Same hashed value to both calls (Expo sets `request.nonce` verbatim; Apple
    echoes it into the idToken `nonce` claim; Better Auth does
    `jwtClaims.nonce !== nonce`). Apple returns name/email only on first consent
    — forward them. On success → `router.replace("/(tabs)")`.
- **No deep-link route** beyond the OAuth `openAuthSessionAsync` redirect
  (handled inline). No `magic.tsx`.

### Component 3 — Web (`apps/web`)

- **Client** (`src/auth/client.ts`): no change — `signIn.social` is core.
- **New web `SocialButton`** (`src/components/SocialButton.tsx`) mirroring
  mobile's prop contract (`provider`, `label`, `onPress`, `busy`), using the
  existing `.social` CSS class.
- **UI** (`src/components/AuthForm.tsx`): replace the hardcoded Google stub
  `<button>` (the `onClick` that sets "not wired yet") and add an Apple control,
  after the `or` divider:
  - **Google / Apple** — `signIn.social({ provider, callbackURL })` → full-page
    redirect to provider and back. Web Apple uses the Services-ID web OAuth (no
    native module).
  - **`callbackURL`** = the real authenticated route **`/home`** (NOT
    `/dashboard`, which doesn't exist → 404), as an **absolute** web-origin URL
    (the API is a separate origin; a relative path would resolve against the
    API). Reuse the form's existing `safeFrom ?? "/home"` so social lands on the
    intended destination, same as password sign-in (`AuthForm.tsx:144`). Session
    cookie is set on the web origin (same-site).

## Error handling

Both apps run the Better Auth client error / native result through
`classifySocialAuthError` (shared):
- `oauth_cancelled` — user dismissed the provider sheet (mobile: `WebBrowser`
  `cancel` / Apple `ERR_REQUEST_CANCELED`; web: popup closed). **Silent** — stop.
- `apple_signin_unavailable` — Apple native unavailable (Android / Expo Go);
  mainly prevented by hiding the button.
- `oauth_failed` — provider/token/link error → one friendly retry message.
Account-linking conflicts are prevented by the verified-email default; otherwise
surfaced as `oauth_failed`.

## Testing

- **Server config** (api integration, real DB, `testEnv` ±creds): assert
  `auth.options.socialProviders` has `google`+`apple` when env set, neither when
  unset; assert `account.accountLinking.enabled === true` and `trustedProviders`
  unset.
- **`classifySocialAuthError`** (shared unit test): cancel-shaped, provider-error
  shaped, unknown inputs → expected `SocialAuthError`; `SOCIAL_AUTH_ERRORS`
  exported.
- **Client wiring**: `nx typecheck mobile` + `nx typecheck web` (the
  `signIn.social` calls, apple-auth + crypto imports, widened `socialProviders`
  type, removed magic button). OAuth/Apple round-trips are external → manual
  on-device/browser testing once creds land.

## Edge cases

- **Expo Go**: native Apple unavailable → button hidden. Google works only in a
  dev build (the `fina://` scheme + the expo OAuth handoff; Expo Go's runtime
  scheme is `exp://`). Document this — consistent with the IAP/Plaid dev-build
  posture.
- **Android**: Apple button hidden.
- **Apple private relay**: hidden-email users get a
  `…@privaterelay.appleid.com` address; Better Auth stores it (unique + routable).
- **Apple first-consent only**: name/email arrive only on the first
  authorization — capture + forward then.

## Env / external setup the operator must supply (after code lands)

- **Google** (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`): Google Cloud → OAuth
  consent screen + a **Web** OAuth client; authorized redirect URI
  `{BETTER_AUTH_URL}/api/auth/callback/google`.
- **Apple** (`APPLE_CLIENT_ID` = **Services ID**, `APPLE_TEAM_ID`,
  `APPLE_KEY_ID`, `APPLE_CLIENT_SECRET` = JWT signed from the `.p8` key): Apple
  Developer → enable "Sign in with Apple" on the `com.withfina.app` App ID;
  create a **Services ID** (web) with return URL
  `{BETTER_AUTH_URL}/api/auth/callback/apple` + a verified web domain; create a
  Sign-in key (`.p8`). **`APPLE_CLIENT_SECRET` is a JWT Apple caps at ≤6 months**
  — operational reminder to regenerate (Better Auth accepts only a static
  string). Native iOS needs only the capability + bundle id (already
  `com.withfina.app`).

## Out of scope

- **Magic link / passwordless email** — deferred.
- Linking/unlinking providers from a settings screen.
- Web Apple domain-verification automation (operator does it in Apple Developer).
- Changing the existing email-OTP sign-up verification.
