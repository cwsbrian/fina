import { HttpError } from "../auth/context.js";

export type AppleIapConfig = {
  bundleId: string;
  ascIssuerId: string;
  ascKeyId: string;
  ascPrivateKey: string;
  env: "sandbox" | "production";
  /** App Store Connect numeric ID. Required in production because
   *  Apple's SDK validates it against the ASSN V2 notification payload.
   *  Optional in sandbox (the SDK's notification verifier skips this
   *  check when env=Sandbox). */
  appAppleId?: number;
};

export type GoogleIapConfig = {
  packageName: string;
  serviceAccount: { client_email: string; private_key: string; [k: string]: unknown };
  pubsubVerifyAudience: string;
  pubsubVerifyEmail: string;
  pubsubSubscriptionName: string;
};

export type IapConfig = { apple: AppleIapConfig; google: GoogleIapConfig };

const need = (env: NodeJS.ProcessEnv) => (k: string): string => {
  const v = env[k];
  if (!v) throw new HttpError(503, "iap_not_configured", `${k} is not set`);
  return v;
};

/** Validate ONLY the Apple half. Use when the request is known to be
 *  iOS — avoids forcing Google env (and vice versa with the Google
 *  variant). When you need both halves at once (e.g., the IAP webhook
 *  route that fans in both ASSN + RTDN), use requireIapEnv(). */
export function requireAppleIapEnv(env: NodeJS.ProcessEnv): AppleIapConfig {
  const n = need(env);
  const appleKeyRaw = n("APPLE_ASC_PRIVATE_KEY");
  const appleKey = appleKeyRaw.includes("BEGIN PRIVATE KEY")
    ? appleKeyRaw
    : Buffer.from(appleKeyRaw, "base64").toString("utf8");
  if (!appleKey.includes("BEGIN PRIVATE KEY")) {
    throw new HttpError(503, "iap_not_configured", "APPLE_ASC_PRIVATE_KEY shape invalid");
  }

  const appleEnvRaw = n("APPLE_ENV");
  if (appleEnvRaw !== "sandbox" && appleEnvRaw !== "production") {
    throw new HttpError(503, "iap_not_configured", "APPLE_ENV must be sandbox|production");
  }

  const appAppleIdRaw = env.APPLE_APP_APPLE_ID;
  const appAppleId =
    appAppleIdRaw === undefined || appAppleIdRaw === ""
      ? undefined
      : typeof appAppleIdRaw === "number"
        ? appAppleIdRaw
        : Number.parseInt(String(appAppleIdRaw), 10);

  if (appleEnvRaw === "production" && (appAppleId === undefined || !Number.isFinite(appAppleId) || appAppleId <= 0)) {
    throw new HttpError(503, "iap_not_configured", "APPLE_APP_APPLE_ID is required in production");
  }

  return {
    bundleId: n("APPLE_BUNDLE_ID"),
    ascIssuerId: n("APPLE_ASC_ISSUER_ID"),
    ascKeyId: n("APPLE_ASC_KEY_ID"),
    ascPrivateKey: appleKey,
    env: appleEnvRaw,
    ...(appAppleId !== undefined ? { appAppleId } : {}),
  };
}

/** Validate ONLY the Google half. Pub/Sub fields are required because
 *  the webhook route depends on them; we keep them in the same config
 *  so callers that need receipt validation alone (checkout/restore)
 *  still pay the full Google cost up front rather than splitting into
 *  a third type. If you ever want receipt-only Google (no Pub/Sub),
 *  add a `requireGoogleReceiptEnv()` variant — for now Pub/Sub is
 *  cheap enough to require together. */
export function requireGoogleIapEnv(env: NodeJS.ProcessEnv): GoogleIapConfig {
  const n = need(env);
  const saRaw = n("GOOGLE_SERVICE_ACCOUNT_JSON");
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

  return {
    packageName: n("GOOGLE_PACKAGE_NAME"),
    serviceAccount,
    pubsubVerifyAudience: n("GOOGLE_PUBSUB_VERIFY_AUDIENCE"),
    pubsubVerifyEmail: n("GOOGLE_PUBSUB_VERIFY_EMAIL"),
    pubsubSubscriptionName: n("GOOGLE_PUBSUB_SUBSCRIPTION_NAME"),
  };
}

/** Returns a fully-validated IAP config or throws HttpError(503,
 *  "iap_not_configured"). The thrown error NEVER carries any portion
 *  of an env value — only the var key name. Callers should use this
 *  inside route handlers / sync helpers so that IAP-less dev / test
 *  envs surface a clean 503 rather than a generic 500. */
export function requireIapEnv(env: NodeJS.ProcessEnv): IapConfig {
  return { apple: requireAppleIapEnv(env), google: requireGoogleIapEnv(env) };
}
