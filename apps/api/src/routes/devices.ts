import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { RegisterDeviceBody } from "@fina/shared";

export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  app.post("/devices", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = RegisterDeviceBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const { expoPushToken, platform } = parsed.data;

      await prisma.userDevice.upsert({
        where: { userId_expoPushToken: { userId: session.userId, expoPushToken } },
        create: {
          userId: session.userId,
          expoPushToken,
          platform,
          lastSeenAt: new Date(),
        },
        update: {
          platform,           // in case user reinstalls; keep platform fresh
          lastSeenAt: new Date(),
        },
      });
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
