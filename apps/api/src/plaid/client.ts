import { Configuration, PlaidApi, PlaidEnvironments, type Products, type CountryCode } from "plaid";
import type { Env } from "../env.js";
import { HttpError } from "../auth/context.js";

let cached: PlaidApi | null = null;
let cachedFor: string | null = null;

export function plaidClient(env: Env): PlaidApi {
  // Cache key includes the SECRET as well — otherwise a test that flips
  // PLAID_SECRET while keeping client id + env constant would silently reuse
  // a client configured with the old secret.
  const cacheKey = `${env.PLAID_ENV}|${env.PLAID_CLIENT_ID}|${env.PLAID_SECRET}`;
  if (cached && cachedFor === cacheKey) return cached;
  cached = new PlaidApi(
    new Configuration({
      // Non-null: PlaidEnvironments is typed as `[env: string]: string` so
      // indexed access yields `string | undefined` under noUncheckedIndexedAccess,
      // but our zod enum restricts PLAID_ENV to `sandbox`/`production` which the
      // SDK guarantees are present.
      basePath: PlaidEnvironments[env.PLAID_ENV]!,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID,
          "PLAID-SECRET": env.PLAID_SECRET,
          "Plaid-Version": "2020-09-14",
        },
      },
    }),
  );
  cachedFor = cacheKey;
  return cached;
}

export const PLAID_PRODUCTS: Products[] = ["transactions" as Products];
export const PLAID_COUNTRY_CODES: CountryCode[] = [
  "CA" as CountryCode,
  "US" as CountryCode,
];

/**
 * Plaid SDK errors (axios-shaped) include the request body in `error.config.data`,
 * which contains the access_token. Strip everything except the safe allowlist
 * before logging or returning to the client.
 */
export function sanitizePlaidError(e: unknown): {
  error_code: string | null;
  error_type: string | null;
  error_message: string | null;
  request_id: string | null;
  http_status: number | null;
} {
  const any = e as Record<string, unknown>;
  const data = (any?.response as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const status = (any?.response as Record<string, unknown> | undefined)?.status as number | undefined;
  return {
    error_code: (data?.error_code as string) ?? null,
    error_type: (data?.error_type as string) ?? null,
    error_message: (data?.error_message as string) ?? null,
    request_id: (data?.request_id as string) ?? null,
    http_status: status ?? null,
  };
}

export function isPlaidErrorCode(e: unknown, code: string): boolean {
  return sanitizePlaidError(e).error_code === code;
}

export function isPlaidApiError(e: unknown): boolean {
  return sanitizePlaidError(e).error_code !== null;
}

/** Map a Plaid error to our HttpError taxonomy. Always sanitized. */
export function mapPlaidError(e: unknown): HttpError {
  const s = sanitizePlaidError(e);
  switch (s.error_code) {
    case "ITEM_LOGIN_REQUIRED":
    case "ITEM_LOCKED":
    case "INVALID_CREDENTIALS":
      return new HttpError(409, "plaid_login_required", s.error_message ?? "");
    case "INVALID_PUBLIC_TOKEN":
    case "INVALID_REQUEST":
      return new HttpError(410, "plaid_link_expired", s.error_message ?? "");
    case "ITEM_NOT_FOUND":
      // Caller usually treats this as success on disconnect path; only mapped here
      // if it leaks to a route handler unexpectedly.
      return new HttpError(404, "plaid_item_not_found", s.error_message ?? "");
    default:
      return new HttpError(502, "plaid_unavailable", s.error_message ?? "Plaid request failed");
  }
}
