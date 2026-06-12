import { WORKSPACE_HEADER } from "../constants.js";
import type { ApiError, ApiErrorCode } from "../errors.js";

// Factory for the per-app `apiFetch`. Each app injects its platform-specific
// pieces (storage for the active workspace id, cookie strategy) and gets
// back a fully-typed fetch wrapper.
//
// Why a factory and not a direct function:
//  - Web reads workspace id from document.cookie (synchronous).
//  - Mobile reads it from AsyncStorage / SecureStore (async).
//  - Web ships cookies automatically with `credentials: "include"`.
//  - Mobile builds a `Cookie` header manually from Better Auth's expoClient.
//
// Both apps need:
//  - The "no content-type when body-less" workaround for Fastify 5.
//  - The unified ApiError throw on non-ok responses.
//  - The X-Workspace-Id header injection.

export type ApiClientOpts = {
  /** API base URL (no trailing slash). */
  baseUrl: string;
  /** Synchronous or async getter for the active workspace id. */
  getActiveWorkspaceId: () => string | null | Promise<string | null>;
  /** Optional cookie header builder. When omitted, the fetch relies on
   *  browser credentials. */
  getCookieHeader?: () => string | null | Promise<string | null>;
  /** Whether to set `credentials: "include"` (web only — RN ignores it). */
  withCredentials?: boolean;
  /** Optional extra headers, used by native clients for install-scoped
   * metadata such as device id and platform. */
  getExtraHeaders?: () => Record<string, string> | null | Promise<Record<string, string> | null>;
};

export type ApiFetch = <T>(path: string, init?: RequestInit) => Promise<T>;

export function makeApiFetch(opts: ApiClientOpts): ApiFetch {
  return async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const wsId = await opts.getActiveWorkspaceId();
    const cookie = opts.getCookieHeader ? await opts.getCookieHeader() : null;
    const extraHeaders = opts.getExtraHeaders ? await opts.getExtraHeaders() : null;

    // Only declare content-type when there's actually a body — Fastify 5
    // rejects body-less POST/DELETE/PATCH with 400 "Body cannot be empty
    // when content-type is set to 'application/json'".
    const hasBody = init.body !== undefined && init.body !== null;

    let res: Response;
    try {
      res = await fetch(`${opts.baseUrl}${path}`, {
        ...init,
        ...(opts.withCredentials ? { credentials: "include" as const } : {}),
        cache: "no-store",
        headers: {
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...(wsId ? { [WORKSPACE_HEADER]: wsId } : {}),
          ...(cookie ? { cookie } : {}),
          ...(extraHeaders ?? {}),
          ...init.headers,
        },
      });
    } catch {
      const err: ApiError = {
        status: 0,
        code: "network_unreachable",
        message: "Backend is unreachable",
      };
      throw err;
    }

    if (!res.ok) {
      let body: { error?: string; message?: string } = {};
      try {
        body = await res.json();
      } catch {
        // ignore — body might not be json
      }
      const err: ApiError = {
        status: res.status,
        code: (body.error as ApiErrorCode) ?? (`http_${res.status}` as const),
        ...(body.message !== undefined ? { message: body.message } : {}),
      };
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };
}
