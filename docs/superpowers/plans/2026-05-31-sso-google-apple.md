# SSO (Google + Apple) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Google + native-Apple (iOS) / web-OAuth-Apple sign-in on the mobile and web sign-in/sign-up screens; magic link deferred.

**Architecture:** Better Auth brokers it. Server registers the Apple provider + safe account-linking; apps call `signIn.social` with the Google provider (browser/expo redirect) and the Apple provider (native idToken on iOS / web OAuth on web). A shared `classifySocialAuthError` gives both apps identical failure copy. No new `ApiErrorCode`, no DB changes (Account/Session/Verification already exist).

**Tech Stack:** Better Auth 1.6.11 + @better-auth/expo, expo-apple-authentication, expo-crypto, Resend (already), Vitest.

**Spec:** `docs/superpowers/specs/2026-05-31-sso-design.md`

**Test commands:** `pnpm nx test api -- <substr>`, `pnpm nx test shared` (or `pnpm vitest run libs/shared/...`), `pnpm nx typecheck mobile`, `pnpm nx typecheck web`, `pnpm nx typecheck api`. If nx says "Failed to process project graph", run `npx nx reset` once.

---

## File Structure

| File | Change |
|---|---|
| `libs/shared/src/auth/social-errors.ts` | Create — `SOCIAL_AUTH_ERRORS`, `SocialAuthError`, `classifySocialAuthError` |
| `libs/shared/src/index.ts` | Export the new module |
| `libs/shared/src/auth/social-errors.test.ts` | Create — classifier unit tests |
| `apps/api/src/auth.ts` | Apple provider, widened `socialProviders` type, `account.accountLinking` |
| `apps/api/tests/auth.social-providers.test.ts` | Create — provider registration + linking config |
| `apps/mobile/package.json` / `app.json` | `expo-apple-authentication` + `expo-crypto` dep + config plugin |
| `apps/mobile/src/design/AuthButtons.tsx` | `SocialButton`: add `busy`, `disabled` |
| `apps/mobile/app/(auth)/sign-in.tsx` | Remove magic button; wire Google + Apple handlers |
| `apps/mobile/app/(auth)/sign-up.tsx` | Wire Google + Apple handlers |
| `apps/mobile/src/auth/social.ts` | Create — shared mobile handlers (Google + Apple + copy) |
| `apps/web/src/components/SocialButton.tsx` | Create — web social button |
| `apps/web/src/components/AuthForm.tsx` | Replace Google stub, add Apple; `callbackURL` = absolute `/home` |

---

## Task 1: Shared social-auth error classifier

**Files:**
- Create: `libs/shared/src/auth/social-errors.ts`
- Modify: `libs/shared/src/index.ts`
- Test: `libs/shared/src/auth/social-errors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `libs/shared/src/auth/social-errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SOCIAL_AUTH_ERRORS, classifySocialAuthError } from "./social-errors.js";

describe("classifySocialAuthError", () => {
  it("exports the union values", () => {
    expect(SOCIAL_AUTH_ERRORS).toEqual(["oauth_failed", "oauth_cancelled", "apple_signin_unavailable"]);
  });
  it("maps Apple/user cancellation to oauth_cancelled", () => {
    expect(classifySocialAuthError({ code: "ERR_REQUEST_CANCELED" })).toBe("oauth_cancelled");
    expect(classifySocialAuthError({ message: "The operation was canceled." })).toBe("oauth_cancelled");
    expect(classifySocialAuthError({ type: "cancel" })).toBe("oauth_cancelled");
  });
  it("maps Apple-unavailable to apple_signin_unavailable", () => {
    expect(classifySocialAuthError({ message: "Sign in with Apple is not available" })).toBe("apple_signin_unavailable");
  });
  it("maps Better Auth client errors + unknown to oauth_failed", () => {
    expect(classifySocialAuthError({ error: { code: "INVALID_TOKEN", message: "bad" } })).toBe("oauth_failed");
    expect(classifySocialAuthError(new Error("network"))).toBe("oauth_failed");
    expect(classifySocialAuthError(undefined)).toBe("oauth_failed");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run libs/shared/src/auth/social-errors.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `libs/shared/src/auth/social-errors.ts`:

```ts
/** Stable codes for social/OAuth sign-in failures. These are CLIENT-side
 *  Better Auth / native-module results, NOT REST ApiError codes — they never
 *  travel through apiFetch/isApiError, so they live in their own union. */
export const SOCIAL_AUTH_ERRORS = [
  "oauth_failed",
  "oauth_cancelled",
  "apple_signin_unavailable",
] as const;

export type SocialAuthError = (typeof SOCIAL_AUTH_ERRORS)[number];

/** Classify a Better Auth client error object, a thrown native (Apple /
 *  WebBrowser) result, or anything else into one stable code so web + mobile
 *  render identical copy. */
export function classifySocialAuthError(e: unknown): SocialAuthError {
  const obj = (e ?? {}) as {
    code?: string;
    type?: string;
    message?: string;
    error?: { code?: string; message?: string };
  };
  const code = obj.code ?? obj.error?.code ?? "";
  const message = String(obj.message ?? obj.error?.message ?? "");

  if (
    obj.type === "cancel" ||
    code === "ERR_REQUEST_CANCELED" ||
    code === "ERR_CANCELED" ||
    /cancel/i.test(message)
  ) {
    return "oauth_cancelled";
  }
  if (/not available|unavailable/i.test(message) || code === "ERR_APPLE_AUTHENTICATION_UNAVAILABLE") {
    return "apple_signin_unavailable";
  }
  return "oauth_failed";
}
```

Then add to `libs/shared/src/index.ts` (after the existing `export * from "./errors.js";` line, near the other top-level exports):

```ts
export * from "./auth/social-errors.js";
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `pnpm vitest run libs/shared/src/auth/social-errors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add libs/shared/src/auth/social-errors.ts libs/shared/src/auth/social-errors.test.ts libs/shared/src/index.ts
git commit -m "feat(shared): classifySocialAuthError + SocialAuthError union"
```

---

## Task 2: Server — Apple provider + safe account linking

**Files:**
- Modify: `apps/api/src/auth.ts:22-28, 68`
- Test: `apps/api/tests/auth.social-providers.test.ts` (create)

Note: `GOOGLE_*` and `APPLE_*` env vars already exist (optional) in `apps/api/src/env.ts` — no env-schema change.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/auth.social-providers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.js";
import { testEnv } from "./helpers/test-env.js";

describe("createAuth social providers", () => {
  it("registers google + apple when creds are set, and enables safe account linking", () => {
    const auth = createAuth(
      testEnv({
        GOOGLE_CLIENT_ID: "gid",
        GOOGLE_CLIENT_SECRET: "gsecret",
        APPLE_CLIENT_ID: "com.withfina.web",
        APPLE_CLIENT_SECRET: "asecret",
      }),
    );
    const sp = auth.options.socialProviders as Record<string, { clientId: string; appBundleIdentifier?: string }>;
    expect(Object.keys(sp).sort()).toEqual(["apple", "google"]);
    expect(sp.apple.appBundleIdentifier).toBe("com.withfina.app");
    expect(auth.options.account?.accountLinking?.enabled).toBe(true);
    // trustedProviders must NOT be set (that would skip the provider-verified check)
    expect(auth.options.account?.accountLinking?.trustedProviders).toBeUndefined();
  });

  it("registers neither provider when creds are unset", () => {
    const auth = createAuth(testEnv());
    expect(Object.keys((auth.options.socialProviders ?? {}) as object)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm nx test api -- auth.social-providers`
Expected: FAIL — apple not registered / `account` undefined.

- [ ] **Step 3: Implement**

In `apps/api/src/auth.ts`, widen the type + add Apple (replace lines 22-28):

```ts
  const socialProviders: Record<
    string,
    { clientId: string; clientSecret: string; appBundleIdentifier?: string }
  > = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    socialProviders.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET) {
    socialProviders.apple = {
      clientId: env.APPLE_CLIENT_ID, // Services ID (web flow audience)
      clientSecret: env.APPLE_CLIENT_SECRET, // .p8-derived JWT, ≤6mo (operator regenerates)
      appBundleIdentifier: "com.withfina.app", // native iOS idToken audience
    };
  }
```

Then add `account` to the `betterAuth({ ... })` config object — put it right after the `socialProviders,` line (line 68):

```ts
    socialProviders,
    // Link a social sign-in to a pre-existing user by email. Default semantics
    // (NOT trustedProviders, which would skip the provider email-verified check
    // and risk takeover): link only when BOTH the provider email_verified AND
    // the local account are verified.
    account: { accountLinking: { enabled: true } },
```

- [ ] **Step 4: Run to confirm it passes**

Run: `pnpm nx test api -- auth.social-providers`
Expected: PASS (2 tests).

- [ ] **Step 5: Confirm no regression on existing auth tests**

Run: `pnpm nx test api -- auth.session auth.context`
Expected: PASS (the existing email/password + session flows are unchanged).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/auth.ts apps/api/tests/auth.social-providers.test.ts
git commit -m "feat(api): register Apple social provider + safe account linking"
```

---

## Task 3: Mobile — native deps + SocialButton busy/availability

**Files:**
- Modify: `apps/mobile/package.json`, `apps/mobile/app.json`
- Modify: `apps/mobile/src/design/AuthButtons.tsx:50-80`

- [ ] **Step 1: Install the native modules (SDK-correct versions)**

Run (from repo root):
```bash
cd apps/mobile && npx expo install expo-apple-authentication expo-crypto && cd ../..
```
Expected: both added to `apps/mobile/package.json` dependencies. (Native modules → require a dev/preview build, like react-native-iap. They are inert in Expo Go; the Apple button hides there.)

- [ ] **Step 2: Add the Apple config plugin**

In `apps/mobile/app.json`, add `"expo-apple-authentication"` to the `expo.plugins` array (a bare string entry, alongside `"expo-secure-store"` etc.). This enables the iOS "Sign in with Apple" entitlement at prebuild.

- [ ] **Step 3: Extend `SocialButton` with `busy` + `disabled`**

In `apps/mobile/src/design/AuthButtons.tsx`, replace the `SocialProps` type + `SocialButton` function (lines 50-80) with:

```ts
type SocialProps = {
  provider: "google" | "apple" | "magic";
  label: string;
  onPress?: () => void;
  busy?: boolean;
  disabled?: boolean;
};

export function SocialButton({ provider, label, onPress, busy, disabled }: SocialProps) {
  const isApple = provider === "apple";
  const isDisabled = disabled || busy;
  return (
    <Pressable
      onPress={isDisabled ? undefined : onPress}
      style={[
        styles.social,
        isApple && { backgroundColor: colors.ink, borderColor: colors.ink },
        isDisabled && { opacity: 0.6 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={isApple ? "#fff" : colors.ink} />
      ) : (
        <>
          {provider === "google" && <GoogleGlyph />}
          {provider === "apple" && <AppleGlyph />}
          {provider === "magic" && <MailGlyph />}
          <Text
            style={[
              styles.socialText,
              isApple && { color: "#fff" },
              provider === "magic" && { fontWeight: "500" },
            ]}
          >
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}
```

(`ActivityIndicator` is already imported at the top of the file.)

- [ ] **Step 4: Typecheck**

Run: `pnpm nx typecheck mobile 2>&1 | grep -E "AuthButtons" || echo clean`
Expected: `clean` (only the known pre-existing errors elsewhere, if any).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/package.json apps/mobile/pnpm-lock.yaml apps/mobile/app.json apps/mobile/src/design/AuthButtons.tsx pnpm-lock.yaml
git commit -m "feat(mobile): apple-auth + crypto deps; SocialButton busy/disabled"
```

---

## Task 4: Mobile — wire Google + Apple; remove magic button

**Files:**
- Create: `apps/mobile/src/auth/social.ts`
- Modify: `apps/mobile/app/(auth)/sign-in.tsx`, `apps/mobile/app/(auth)/sign-up.tsx`

- [ ] **Step 1: Create the shared mobile handlers**

Create `apps/mobile/src/auth/social.ts`:

```ts
import { Alert, Platform } from "react-native";
import * as Linking from "expo-linking";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { classifySocialAuthError, type SocialAuthError } from "@fina/shared";
import { router } from "expo-router";
import { signIn } from "./client";

function copy(code: SocialAuthError): string {
  switch (code) {
    case "apple_signin_unavailable":
      return "Apple sign-in isn't available on this device.";
    case "oauth_failed":
    default:
      return "Couldn't sign in. Please try again.";
  }
}

/** Surface a failure unless the user simply cancelled. */
function report(e: unknown) {
  const code = classifySocialAuthError(e);
  if (code === "oauth_cancelled") return;
  Alert.alert("Couldn't sign in", copy(code));
}

export async function signInWithGoogle(): Promise<void> {
  try {
    const res = await signIn.social({
      provider: "google",
      callbackURL: Linking.createURL("/"),
    });
    if ((res as { error?: unknown })?.error) return report((res as { error: unknown }).error);
    router.replace("/(tabs)");
  } catch (e) {
    report(e);
  }
}

/** Render the Apple button only where this returns true. */
export async function appleAvailable(): Promise<boolean> {
  return Platform.OS === "ios" && (await AppleAuthentication.isAvailableAsync());
}

export async function signInWithApple(): Promise<void> {
  try {
    // Better Auth compares the idToken nonce by PLAIN string (no re-hash), so
    // the SAME hashed value must go to Apple and to signIn.social.
    const rawNonce = Crypto.randomUUID();
    const hashedNonce = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      rawNonce,
    );
    const cred = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
      nonce: hashedNonce,
    });
    if (!cred.identityToken) return report(new Error("No Apple identity token"));
    // Apple gives name only on first consent — forward it so the user has a name.
    const name = cred.fullName
      ? [cred.fullName.givenName, cred.fullName.familyName].filter(Boolean).join(" ")
      : undefined;
    const res = await signIn.social({
      provider: "apple",
      idToken: { token: cred.identityToken, nonce: hashedNonce },
      ...(name ? { name } : {}),
    } as Parameters<typeof signIn.social>[0]);
    if ((res as { error?: unknown })?.error) return report((res as { error: unknown }).error);
    router.replace("/(tabs)");
  } catch (e) {
    report(e);
  }
}
```

- [ ] **Step 2: Wire `sign-in.tsx` (remove magic, add handlers + availability gate)**

In `apps/mobile/app/(auth)/sign-in.tsx`:

(a) Add imports near the top (after the existing AuthButtons import line 7):
```ts
import { useEffect, useState } from "react";
import { signInWithGoogle, signInWithApple, appleAvailable } from "../../src/auth/social";
```
(`useState` is likely already imported — if so, only add `useEffect` + the social import.)

(b) Inside the component, add availability state:
```ts
  const [showApple, setShowApple] = useState(false);
  useEffect(() => {
    appleAvailable().then(setShowApple);
  }, []);
```

(c) Replace the social block (current lines 101-105) with:
```tsx
      <SocialButton provider="google" label="Continue with Google" onPress={signInWithGoogle} />
      {showApple && (
        <>
          <View style={{ height: 10 }} />
          <SocialButton provider="apple" label="Continue with Apple" onPress={signInWithApple} />
        </>
      )}
```
(The `provider="magic"` button is deleted.)

- [ ] **Step 3: Wire `sign-up.tsx` (add handlers + availability gate)**

In `apps/mobile/app/(auth)/sign-up.tsx`, mirror Step 2 (a) + (b) imports/state, then replace the social block (current lines 132-134) with:
```tsx
      <SocialButton provider="google" label="Continue with Google" onPress={signInWithGoogle} />
      {showApple && (
        <>
          <View style={{ height: 10 }} />
          <SocialButton provider="apple" label="Continue with Apple" onPress={signInWithApple} />
        </>
      )}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm nx typecheck mobile 2>&1 | grep -E "sign-in|sign-up|auth/social" || echo clean`
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add "apps/mobile/src/auth/social.ts" "apps/mobile/app/(auth)/sign-in.tsx" "apps/mobile/app/(auth)/sign-up.tsx"
git commit -m "feat(mobile): wire Google + native Apple sign-in; drop deferred magic button"
```

---

## Task 5: Web — SocialButton + AuthForm Google/Apple wiring

**Files:**
- Create: `apps/web/src/components/SocialButton.tsx`
- Modify: `apps/web/src/components/AuthForm.tsx`

- [ ] **Step 1: Create the web `SocialButton`**

Create `apps/web/src/components/SocialButton.tsx`:

```tsx
"use client";
import styles from "./auth.module.css";

type Props = {
  provider: "google" | "apple";
  label: string;
  onClick: () => void;
  busy?: boolean;
};

export function SocialButton({ provider, label, onClick, busy }: Props) {
  return (
    <button
      type="button"
      className={styles.social}
      onClick={onClick}
      disabled={busy}
      aria-label={label}
    >
      {provider === "google" ? <GoogleGlyph /> : <AppleGlyph />}
      {busy ? "…" : label}
    </button>
  );
}

function GoogleGlyph() {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.7-3.87 2.7-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.34A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.95 10.7a5.41 5.41 0 0 1 0-3.4V4.96H.94a9 9 0 0 0 0 8.08l3.01-2.34z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A9 9 0 0 0 .94 4.96L3.95 7.3C4.66 5.17 6.65 3.58 9 3.58z" />
    </svg>
  );
}

function AppleGlyph() {
  return (
    <svg width={16} height={18} viewBox="0 0 16 18" aria-hidden>
      <path fill="currentColor" d="M13.05 9.55c-.02-2.13 1.74-3.16 1.82-3.21-1-1.46-2.55-1.66-3.1-1.68-1.32-.13-2.58.78-3.25.78-.67 0-1.71-.76-2.81-.74-1.45.02-2.78.84-3.53 2.13-1.5 2.6-.38 6.43 1.08 8.54.72 1.03 1.57 2.19 2.68 2.15 1.07-.04 1.48-.69 2.78-.69s1.67.69 2.81.67c1.16-.02 1.9-1.05 2.6-2.09a9.2 9.2 0 0 0 1.18-2.42c-.03-.01-2.26-.87-2.28-3.44zM10.96 3.32c.59-.71.98-1.7.87-2.69-.84.03-1.86.56-2.46 1.27-.54.63-1.01 1.64-.88 2.61.94.07 1.89-.48 2.47-1.19z" />
    </svg>
  );
}
```

- [ ] **Step 2: Wire AuthForm — replace the Google stub, add Apple**

In `apps/web/src/components/AuthForm.tsx`:

(a) Add imports (near line 10, with the other imports):
```ts
import { SocialButton } from "./SocialButton";
import { classifySocialAuthError } from "@fina/shared";
import { env } from "../env";
```

(b) Inside the component, add a handler that redirects to the provider. `safeFrom` (line 25) is the validated post-auth path:
```ts
  async function social(provider: "google" | "apple") {
    setErr(null);
    const callbackURL = `${env.NEXT_PUBLIC_WEB_URL}${safeFrom ?? "/home"}`;
    const res = await signIn.social({ provider, callbackURL });
    if (res?.error) {
      const code = classifySocialAuthError(res.error);
      if (code !== "oauth_cancelled") setErr("Couldn't sign in. Please try again.");
    }
    // On success Better Auth performs a full-page redirect to the provider.
  }
```
(If `env` has no `NEXT_PUBLIC_WEB_URL`, use the existing web origin constant the app already uses for absolute links; confirm the env key during implementation — `apps/web/src/env.ts`. The key requirement: an ABSOLUTE web-origin URL, not a bare `/home`, because the API is a different origin.)

(c) Replace the Google stub block (current lines 295-322 — the `<div className={styles.divider}>or</div>` is line 295; the stub `<button className={styles.social}>…Continue with Google…</button>` is 297-322). Keep the divider, replace the stub button with:
```tsx
          <div className={styles.divider}>or</div>
          <SocialButton provider="google" label="Continue with Google" onClick={() => social("google")} />
          <SocialButton provider="apple" label="Continue with Apple" onClick={() => social("apple")} />
```

- [ ] **Step 3: Typecheck web**

Run: `pnpm nx typecheck web 2>&1 | grep -E "AuthForm|SocialButton" || echo clean`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/SocialButton.tsx apps/web/src/components/AuthForm.tsx
git commit -m "feat(web): wire Google + Apple sign-in (replace stub)"
```

---

## Task 6: Full verification

- [ ] **Step 1: Typecheck all three projects (touched files clean)**

Run:
```bash
pnpm nx typecheck api  2>&1 | grep -E "auth\.ts" || echo "api: auth.ts clean"
pnpm nx typecheck mobile 2>&1 | grep -E "AuthButtons|sign-in|sign-up|auth/social" || echo "mobile: touched clean"
pnpm nx typecheck web 2>&1 | grep -E "AuthForm|SocialButton" || echo "web: touched clean"
```
Expected: each prints its "clean" line (pre-existing unrelated errors out of scope).

- [ ] **Step 2: Run the test surface**

Run: `pnpm nx test api -- auth.social-providers auth.session auth.context` then `pnpm vitest run libs/shared/src/auth/social-errors.test.ts`
Expected: all PASS.

- [ ] **Step 3: Operator env note (no code)**

Confirm the doc list of required env (already in the spec §Env) is accurate against `apps/api/src/env.ts` keys: `GOOGLE_CLIENT_ID/SECRET`, `APPLE_CLIENT_ID/SECRET/KEY_ID/TEAM_ID`. The redirect URIs are `{BETTER_AUTH_URL}/api/auth/callback/{google,apple}`. (Apple also needs `APPLE_KEY_ID`+`APPLE_TEAM_ID` to derive the client secret JWT only if you generate it dynamically; here the operator supplies a pre-built `APPLE_CLIENT_SECRET` string.)

---

## Self-review notes (author)

- **Spec coverage:** Task 1 → shared classifier (no ApiErrorCode). Task 2 → Apple provider + widened type + safe linking. Tasks 3-4 → mobile deps, SocialButton busy/availability, Google + native-Apple (nonce hash) handlers, magic button removed, iOS-only Apple gate. Task 5 → web SocialButton + Google/Apple wiring + absolute `/home` callbackURL. Task 6 → typecheck + tests.
- **No placeholders:** every code + test block is complete; the one runtime confirmation (the exact web env key for the absolute origin) is called out explicitly with the file to check.
- **Type consistency:** `classifySocialAuthError` / `SocialAuthError` / `signInWithGoogle` / `signInWithApple` / `appleAvailable` / `SocialButton` props are used identically across tasks.
- **Manual (post-creds) testing:** Google + Apple round-trips are external; once the operator adds creds, test on a dev build (iOS Apple native + Google) and in the browser (web). Magic link deferred.
