import { HttpError } from "../auth/context.js";

export type AppleIapConfig = {
  bundleId: string;
  ascIssuerId: string;
  ascKeyId: string;
  ascPrivateKey: string;
  env: "sandbox" | "production";
};

export type GoogleIapConfig = {
  packageName: string;
  serviceAccount: { client_email: string; private_key: string; [k: string]: unknown };
  pubsubVerifyAudience: string;
  pubsubVerifyEmail: string;
  pubsubSubscriptionName: string;
};

export type IapConfig = { apple: AppleIapConfig; google: GoogleIapConfig };

/** Returns a fully-validated IAP config or throws HttpError(503,
 *  "iap_not_configured"). The thrown error NEVER carries any portion
 *  of an env value — only the var key name. Callers should use this
 *  inside route handlers / sync helpers so that IAP-less dev / test
 *  envs surface a clean 503 rather than a generic 500. */
export function requireIapEnv(env: NodeJS.ProcessEnv): IapConfig {
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new HttpError(503, "iap_not_configured", `${k} is not set`);
    return v;
  };

  const appleKeyRaw = need("APPLE_ASC_PRIVATE_KEY");
  // Try raw PEM first; fall back to base64 if the header marker is missing.
  // Buffer.from(..., "base64") never throws (invalid chars are silently
  // skipped), so the subsequent shape check catches garbage decodes.
  const appleKey = appleKeyRaw.includes("BEGIN PRIVATE KEY")
    ? appleKeyRaw
    : Buffer.from(appleKeyRaw, "base64").toString("utf8");
  if (!appleKey.includes("BEGIN PRIVATE KEY")) {
    throw new HttpError(503, "iap_not_configured", "APPLE_ASC_PRIVATE_KEY shape invalid");
  }

  const appleEnvRaw = need("APPLE_ENV");
  if (appleEnvRaw !== "sandbox" && appleEnvRaw !== "production") {
    throw new HttpError(503, "iap_not_configured", "APPLE_ENV must be sandbox|production");
  }

  const apple: AppleIapConfig = {
    bundleId: need("APPLE_BUNDLE_ID"),
    ascIssuerId: need("APPLE_ASC_ISSUER_ID"),
    ascKeyId: need("APPLE_ASC_KEY_ID"),
    ascPrivateKey: appleKey,
    env: appleEnvRaw,
  };

  const saRaw = need("GOOGLE_SERVICE_ACCOUNT_JSON");
  // Same raw-first-then-base64 strategy as the Apple key above. JSON.parse
  // below catches garbage decodes.
  const saText = saRaw.trimStart().startsWith("{")
    ? saRaw
    : Buffer.from(saRaw, "base64").toString("utf8");
  let serviceAccount: GoogleIapConfig["serviceAccount"];
  try {
    serviceAccount = JSON.parse(saText);
  } catch {
    throw new HttpError(503, "iap_not_configured", "GOOGLE_SERVICE_ACCOUNT_JSON parse failed");
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key) {
    throw new HttpError(503, "iap_not_configured", "GOOGLE_SERVICE_ACCOUNT_JSON missing client_email/private_key");
  }

  const google: GoogleIapConfig = {
    packageName: need("GOOGLE_PACKAGE_NAME"),
    serviceAccount,
    pubsubVerifyAudience: need("GOOGLE_PUBSUB_VERIFY_AUDIENCE"),
    pubsubVerifyEmail: need("GOOGLE_PUBSUB_VERIFY_EMAIL"),
    pubsubSubscriptionName: need("GOOGLE_PUBSUB_SUBSCRIPTION_NAME"),
  };

  return { apple, google };
}
