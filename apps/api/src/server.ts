import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import type { Env } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { createAuth, type FinaAuth } from "./auth.js";

export type AppCtx = { env: Env; auth: FinaAuth };

declare module "fastify" {
  interface FastifyInstance {
    fina: AppCtx;
  }
}

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: "info" },
  });
  const auth = createAuth(env);
  app.decorate("fina", { env, auth });

  await app.register(sensible);
  await app.register(cors, {
    origin: env.NODE_ENV === "production" ? false : ["http://localhost:3000"],
    credentials: true,
  });

  // Bridge Fastify request → Web Fetch handler that Better Auth expects.
  app.all("/api/auth/*", async (req, reply) => {
    const url = new URL(req.url, env.BETTER_AUTH_URL);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const init: RequestInit = {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : typeof req.body === "string"
            ? req.body
            : JSON.stringify(req.body ?? {}),
    };
    const response = await auth.handler(new Request(url, init));

    reply.code(response.status);
    response.headers.forEach((value, key) => reply.header(key, value));
    const buf = Buffer.from(await response.arrayBuffer());
    return reply.send(buf);
  });

  await app.register(healthRoutes);
  await app.register(meRoutes);

  return app;
}
