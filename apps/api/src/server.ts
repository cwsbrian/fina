import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { RATE_LIMITS } from "@fina/shared";
import type { Env } from "./env.js";
import { registerSessionDecorator, ipKey } from "./auth/session-decorator.js";
import { withRateLimit } from "./auth/rate-limit.js";
import { healthRoutes } from "./routes/health.js";
import { meRoutes } from "./routes/me.js";
import { workspacesRoutes } from "./routes/workspaces.js";
import { inviteRoutes } from "./routes/invites.js";
import { plaidWebhookRoutes } from "./routes/plaid-webhook.js";
import { plaidRoutes } from "./routes/plaid.js";
import { plaidItemsRoutes } from "./routes/plaid-items.js";
import { accountsRoutes } from "./routes/accounts.js";
import { transactionsRoutes } from "./routes/transactions.js";
import { budgetsRoutes } from "./routes/budgets.js";
import { recurringRoutes } from "./routes/recurring.js";
import { schedulesRoutes } from "./routes/schedules.js";
import { categoriesRoutes } from "./routes/categories.js";
import { intentsRoutes } from "./routes/intents.js";
import { chatRoutes } from "./routes/chat.js";
import { createAuth, parseDevOrigins, type FinaAuth } from "./auth.js";

export type AppCtx = { env: Env; auth: FinaAuth };

declare module "fastify" {
  interface FastifyInstance {
    fina: AppCtx;
  }
}

export async function buildApp(env: Env): Promise<FastifyInstance> {
  const app = Fastify({
    logger: env.NODE_ENV === "test" ? false : { level: "info" },
    trustProxy: env.TRUST_PROXY,
  });
  const auth = createAuth(env);
  app.decorate("fina", { env, auth });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: { "default-src": ["'none'"] },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    frameguard: { action: "deny" },
  });
  await app.register(sensible);

  // ORDER MATTERS: session-decorator MUST register before rate-limit so
  // req.userId is populated when the plugin's keyGenerator runs.
  registerSessionDecorator(app);

  const isTest = env.NODE_ENV === "test";
  const rateLimitEnabled = !isTest || env.RATE_LIMIT_TEST === "1";
  if (rateLimitEnabled) {
    await app.register(rateLimit, {
      global: true,
      max: RATE_LIMITS.globalDefault.max,
      timeWindow: RATE_LIMITS.globalDefault.windowMs,
      keyGenerator: ipKey,
      errorResponseBuilder: (_req, ctx) => ({
        statusCode: 429,
        error: "rate_limit_exceeded",
        message: `Rate limit exceeded. Retry in ${Math.ceil(ctx.ttl / 1000)}s.`,
      }),
    });
  }

  await app.register(cors, {
    origin:
      env.NODE_ENV === "production"
        ? false
        : [
            "http://localhost:3000",
            "http://localhost:3100",
            ...parseDevOrigins(env.DEV_ORIGINS),
          ],
    credentials: true,
    // Be explicit about methods + headers so preflight (OPTIONS) for PATCH/DELETE
    // with our custom `X-Workspace-Id` header succeeds without surprises.
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-workspace-id", "cookie"],
  });

  // Bridge Fastify request → Web Fetch handler that Better Auth expects.
  app.all("/api/auth/*", { config: withRateLimit("auth") }, async (req, reply) => {
    const url = new URL(req.url, env.BETTER_AUTH_URL);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(", "));
    }
    const body =
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body ?? {});
    const init: RequestInit =
      body === undefined
        ? { method: req.method, headers }
        : { method: req.method, headers, body };
    const response = await auth.handler(new Request(url, init));

    reply.code(response.status);
    // Forward all headers EXCEPT set-cookie via forEach (forEach combines
    // multiple set-cookie values into a comma-joined string, which browsers
    // misparse as a single broken cookie). Use getSetCookie() — which returns
    // a string[] per spec — and pass that array to reply.header so Fastify
    // emits one Set-Cookie per entry.
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") return;
      reply.header(key, value);
    });
    const setCookies = response.headers.getSetCookie();
    if (setCookies.length > 0) reply.header("set-cookie", setCookies);
    const buf = Buffer.from(await response.arrayBuffer());
    return reply.send(buf);
  });

  await app.register(healthRoutes);
  await app.register(meRoutes);
  await app.register(workspacesRoutes);
  await app.register(inviteRoutes);
  await app.register(plaidWebhookRoutes);
  await app.register(plaidRoutes);
  await app.register(plaidItemsRoutes);
  await app.register(accountsRoutes);
  await app.register(transactionsRoutes);
  await app.register(categoriesRoutes);
  await app.register(budgetsRoutes);
  await app.register(recurringRoutes);
  await app.register(schedulesRoutes);
  await app.register(intentsRoutes);
  await app.register(chatRoutes);

  return app;
}
