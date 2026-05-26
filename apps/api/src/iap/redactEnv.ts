const IAP_SECRET_KEYS = new Set([
  "APPLE_ASC_PRIVATE_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
]);

/** Returns a shallow copy of `env` with IAP secret values replaced by
 *  `[REDACTED]`. Use anywhere env content might be logged or printed.
 *  Pino's redact config covers structured logs; this helper covers
 *  ad-hoc diagnostics that bypass Pino (e.g. boot-time stderr). */
export function redactEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = IAP_SECRET_KEYS.has(k) ? "[REDACTED]" : v;
  }
  return out;
}
