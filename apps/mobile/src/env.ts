import { z } from "zod";

const Schema = z.object({
  EXPO_PUBLIC_API_URL: z.string().url(),
  EXPO_PUBLIC_WEB_URL: z.string().url(),
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
    };
