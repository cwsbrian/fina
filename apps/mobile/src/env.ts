import { z } from "zod";
import Constants, { ExecutionEnvironment } from "expo-constants";

/** True when running inside Expo Go, where native modules are unavailable:
 *  NitroModules (react-native-iap) and remote push (expo-notifications, removed
 *  from Expo Go in SDK 53) both throw or log on load. Gate native-only code
 *  behind this so the app stays usable in Expo Go for UI development. False in
 *  dev client / standalone / production builds. */
export const isExpoGo =
  Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

const Schema = z.object({
  EXPO_PUBLIC_API_URL: z.string().url(),
  EXPO_PUBLIC_WEB_URL: z.string().url(),
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: z.string().optional(),
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: z.string().optional(),
});

// Why not just throw at module init: a thrown Zod error here crashes
// the JS engine before the React tree mounts, so the app appears to
// die silently on a sideloaded build with the env vars unset. We
// surface a deferred error instead — the constants stay valid-looking
// strings so import-time code paths (auth/client createAuthClient,
// api/client baseUrl) don't throw at module load, and the user sees
// a clear "API URL not configured" message in the UI if anything
// actually tries to hit the network.
const parsed = Schema.safeParse({
  EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
  EXPO_PUBLIC_WEB_URL: process.env.EXPO_PUBLIC_WEB_URL,
  EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
  EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
});

export const envError: string | null = parsed.success
  ? null
  : "EXPO_PUBLIC_API_URL / EXPO_PUBLIC_WEB_URL are not configured in this build. " +
    "If this is an EAS build, add them to the matching profile in eas.json.";

export const env = parsed.success
  ? parsed.data
  : {
      // Placeholder URLs that pass URL parsing but route nowhere — any
      // actual fetch will fail fast with a network error rather than
      // a confusing module-init crash.
      EXPO_PUBLIC_API_URL: "https://invalid.localhost",
      EXPO_PUBLIC_WEB_URL: "https://invalid.localhost",
      EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: undefined,
      EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: undefined,
    };
