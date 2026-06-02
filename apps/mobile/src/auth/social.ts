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
    const callbackURL = Linking.createURL("/");
    const res = await signIn.social({
      provider: "google",
      callbackURL,
    });
    if (res.error) return report(res.error);
    // @better-auth/expo silently returns (no error, no session) when the user
    // dismisses the browser — only navigate when a session actually resulted.
    if (!res.data) return;
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
    // Apple returns the name only on first consent. Better Auth's
    // socialSignInBodySchema has NO top-level `name`; the display name goes at
    // idToken.user.name = { firstName, lastName } (the server reads
    // idToken.user). So forward it there — no cast needed.
    const hasName = Boolean(cred.fullName?.givenName || cred.fullName?.familyName);
    const res = await signIn.social({
      provider: "apple",
      idToken: {
        token: cred.identityToken,
        nonce: hashedNonce,
        ...(hasName
          ? {
              user: {
                name: {
                  firstName: cred.fullName?.givenName ?? undefined,
                  lastName: cred.fullName?.familyName ?? undefined,
                },
              },
            }
          : {}),
      },
    });
    if (res.error) return report(res.error);
    router.replace("/(tabs)");
  } catch (e) {
    report(e);
  }
}
