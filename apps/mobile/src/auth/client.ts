import { createAuthClient } from "better-auth/react";
import { expoClient } from "@better-auth/expo/client";
import * as SecureStore from "expo-secure-store";
import { env } from "../env";

export const authClient = createAuthClient({
  baseURL: `${env.EXPO_PUBLIC_API_URL}/api/auth`,
  plugins: [expoClient({ scheme: "fina", storagePrefix: "fina", storage: SecureStore })],
});

export const { useSession, signIn, signUp, signOut } = authClient;
