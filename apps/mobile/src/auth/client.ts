import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import { emailOTPClient } from "better-auth/client/plugins";
import * as SecureStore from "expo-secure-store";
import { env } from "../env";

type AuthResult = Promise<{
  error?: { code?: string; message?: string | null } | null;
  data?: unknown;
}>;

type MobileAuthClient = {
  getCookie?: () => string;
  useSession: () => {
    data?: { user?: { id?: string; email?: string } } | null;
    isPending: boolean;
    error?: unknown;
  };
  signIn: {
    email: (input: { email: string; password: string }) => AuthResult;
    social: (input:
      | { provider: "google"; callbackURL: string }
      | {
          provider: "apple";
          idToken: {
            token: string;
            nonce: string;
            user?: {
              name?: {
                firstName?: string | undefined;
                lastName?: string | undefined;
              };
            };
          };
        }) => AuthResult;
  };
  signUp: {
    email: (input: { email: string; password: string; name: string }) => AuthResult;
  };
  signOut: () => AuthResult;
  changePassword: (input: {
    currentPassword: string;
    newPassword: string;
  }) => AuthResult;
  requestPasswordReset: (input: {
    email: string;
    redirectTo: string;
  }) => AuthResult;
  resetPassword: (input: { newPassword: string; token: string }) => AuthResult;
  emailOtp: {
    verifyEmail: (input: { email: string; otp: string }) => AuthResult;
    sendVerificationOtp: (input: {
      email: string;
      type: "email-verification";
    }) => AuthResult;
  };
};

export const authClient = createAuthClient({
  baseURL: `${env.EXPO_PUBLIC_API_URL}/api/auth`,
  plugins: [
    expoClient({ scheme: "fina", storagePrefix: "fina", storage: SecureStore }),
    emailOTPClient(),
  ],
}) as unknown as MobileAuthClient;

export const { useSession, signIn, signUp, signOut } = authClient;
