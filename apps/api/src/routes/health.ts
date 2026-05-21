import type { FastifyInstance } from "fastify";
import type { HealthDTO } from "@fina/shared";
import { prisma } from "../db.js";

async function readyPayload(): Promise<{ status: number; body: HealthDTO }> {
  // Prisma's $queryRaw doesn't accept AbortSignal, so race manually.
  // clearTimeout in finally so the timer doesn't keep the event loop
  // alive when $queryRaw wins the race (matters for graceful shutdown).
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prisma.$queryRaw<[{ "?column?": number }]>`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("db_timeout")), 1000);
      }),
    ]);
    return { status: 200, body: { status: "ok", checks: { db: "ok" } } };
  } catch {
    return { status: 503, body: { status: "degraded", checks: { db: "down" } } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/live", async () => ({ status: "ok" }));

  app.get("/ready", async (_req, reply) => {
    const { status, body } = await readyPayload();
    return reply.code(status).send(body);
  });

  // Alias for backward-compatibility with existing LB configs that
  // hit /health. Same payload as /ready (success path includes
  // status:"ok" which matches the prior trivial response).
  app.get("/health", async (_req, reply) => {
    const { status, body } = await readyPayload();
    return reply.code(status).send(body);
  });
}
