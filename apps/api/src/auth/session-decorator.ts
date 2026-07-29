import type { FastifyInstance, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by sessionDecoratorHook BEFORE rate-limit's onRequest.
     *  Undefined when the request is unauthenticated. */
    userId?: string;
  }
}

/** Resolve the session (async) and decorate req.userId synchronously
 *  before any subsequent onRequest hook (notably @fastify/rate-limit)
 *  reads it. */
export function registerSessionDecorator(app: FastifyInstance): void {
  app.addHook("onRequest", async (req) => {
    if (req.url === "/internal/admin" || req.url.startsWith("/internal/admin/")) return;
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
      const s = await app.fina.auth.api.getSession({ headers });
      if (s?.user) req.userId = s.user.id;
    } catch {
      // Leave userId undefined; the route's own requireSession will surface
      // the auth failure with the proper 401.
    }
  });
}

export function userKey(req: FastifyRequest): string {
  return req.userId ? `u:${req.userId}` : `ip:${req.ip}`;
}

export function ipKey(req: FastifyRequest): string {
  return `ip:${req.ip}`;
}
