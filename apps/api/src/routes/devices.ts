import type { FastifyInstance } from "fastify";
import { prisma } from "../db.js";
import { HttpError, requireSession } from "../auth/context.js";
import { RegisterDeviceBody, UnregisterDeviceBody } from "@fina/shared";
import { logInfo } from "../logger.js";
import { readNativeIapClient } from "../iap/integrity.js";

export async function devicesRoutes(app: FastifyInstance): Promise<void> {
  app.post("/devices", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = RegisterDeviceBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const { expoPushToken, platform } = parsed.data;
      const client = readNativeIapClient(req);

      if (client) {
        const existingByToken = await prisma.userDevice.findUnique({
          where: { userId_expoPushToken: { userId: session.userId, expoPushToken } },
          select: { id: true },
        });
        if (existingByToken) {
          await prisma.userDevice.deleteMany({
            where: {
              userId: session.userId,
              clientDeviceId: client.clientDeviceId,
              id: { not: existingByToken.id },
            },
          });
          await prisma.userDevice.update({
            where: { id: existingByToken.id },
            data: {
              clientDeviceId: client.clientDeviceId,
              platform,
              lastSeenAt: new Date(),
            },
          });
        } else {
          await prisma.userDevice.upsert({
            where: {
              userId_clientDeviceId: {
                userId: session.userId,
                clientDeviceId: client.clientDeviceId,
              },
            },
            create: {
              userId: session.userId,
              clientDeviceId: client.clientDeviceId,
              expoPushToken,
              platform,
              lastSeenAt: new Date(),
            },
            update: {
              expoPushToken,
              platform,
              lastSeenAt: new Date(),
            },
          });
        }
      } else {
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
      }
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });

  app.delete("/devices", async (req, reply) => {
    try {
      const session = await requireSession(req, app);
      const parsed = UnregisterDeviceBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });

      const { expoPushToken } = parsed.data;
      const result = await prisma.userDevice.deleteMany({
        where: { userId: session.userId, expoPushToken },
      });
      // count=0도 로깅 — DELETE가 호출됐다는 audit trail (token rotation /
      // lazy cleanup 후 호출 등 무해한 케이스 추적용).
      logInfo(
        { userId: session.userId, removedDeviceCount: result.count },
        "device unregistered via sign-out",
      );
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.code });
      throw e;
    }
  });
}
