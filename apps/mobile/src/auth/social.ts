import { Alert, Platform } from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { classifySocialAuthError, type SocialAuthError } from "@fina/shared";
import { router } from "expo-router";
import { signIn } from "./client";
import { env, isExpoGo } from "../env";

type GoogleSignInResponse =
  | { type: "success"; data: { idToken: string | null } }
  | { type: "cancelled"; data: null }
  | { type: "noSavedCredentialFound"; data: null };

type GoogleSignInModule = {
  GoogleSignin: {
    configure(options: {
      webClientId: string;
      offlineAccess: boolean;
      iosClientId?: string;
    }): void;
    hasPlayServices(options: { showPlayServicesUpdateDialog: boolean }): Promise<boolean>;
    signIn(): Promise<GoogleSignInResponse>;
  };
};

let googleSignIn: GoogleSignInModule | null | undefined;
let googleConfigured = false;

function getGoogleSignIn(): GoogleSignInModule | null {
  if (googleSignIn !== undefined) return googleSignIn;
  if (isExpoGo) {
    googleSignIn = null;
    return googleSignIn;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    googleSignIn = require("@react-native-google-signin/google-signin/native") as GoogleSignInModule;
  } catch {
    googleSignIn = null;
  }
  return googleSignIn;
}

function configureGoogleSignIn(google: GoogleSignInModule): void {
  if (googleConfigured) return;
  const webClientId = env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim();
  if (!webClientId) {
    throw new Error("Google sign-in is not configured for this build.");
  }
  const iosClientId = env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim();
  if (Platform.OS === "ios" && !iosClientId) {
    throw new Error("Google iOS client ID is not configured for this build.");
  }
  google.GoogleSignin.configure({
    webClientId,
    offlineAccess: false,
    ...(Platform.OS === "ios" && iosClientId ? { iosClientId } : {}),
  });
  googleConfigured = true;
}

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
  const detail =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e !== null
        ? JSON.stringify(e)
        : String(e);
  if (__DEV__) console.error("social auth failed", e);
  Alert.alert("Couldn't sign in", __DEV__ ? `${copy(code)}\n\n${detail}` : copy(code));
}

export async function signInWithGoogle(): Promise<void> {
  try {
    const google = getGoogleSignIn();
    if (!google) {
      throw new Error("Google sign-in requires a development or production build.");
    }
    configureGoogleSignIn(google);
    if (Platform.OS === "android") {
      await google.GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    }
    const nativeResult = await google.GoogleSignin.signIn();
    if (nativeResult.type !== "success") return;
    const token = nativeResult.data.idToken;
    if (!token) {
      throw new Error("Google did not return an identity token.");
    }
    const res = await signIn.social({
      provider: "google",
      idToken: { token },
    });
    if (res.error) return report(res.error);
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
