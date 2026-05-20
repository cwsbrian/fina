import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { env } from "../env";

export const authClient = createAuthClient({
  baseURL: `${env.NEXT_PUBLIC_API_URL}/api/auth`,
  plugins: [emailOTPClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
