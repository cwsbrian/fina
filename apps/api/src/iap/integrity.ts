import type { FastifyRequest } from "fastify";
import type { Subscription, User, UserDevice } from "@prisma/client";
import {
  CLIENT_DEVICE_ID_HEADER,
  CLIENT_PLATFORM_HEADER,
  type MeDTO,
  type SubscriptionSource,
} from "@fina/shared";
import { prisma } from "../db.js";

const IAP_INTEGRITY_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/;

export type NativeIapPlatform = "ios" | "android";

type IapIntegrityDevice = Pick<
  UserDevice,
  | "lastIapIntegrityCheckedAt"
  | "lastIapIntegrityResult"
  | "lastIapIntegritySubscriptionUpdatedAt"
>;

type PrimarySub = Pick<Subscription, "source" | "updatedAt"> | null;

function headerString(value: FastifyRequest["headers"][string]): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
}

export function sourceForNativePlatform(platform: NativeIapPlatform): SubscriptionSource {
  return platform === "ios" ? "iap_apple" : "iap_google";
}

export function readNativeIapClient(req: FastifyRequest): {
  clientDeviceId: string;
  platform: NativeIapPlatform;
} | null {
  const clientDeviceId = headerString(req.headers[CLIENT_DEVICE_ID_HEADER]);
  const platform = headerString(req.headers[CLIENT_PLATFORM_HEADER]);
  if (!clientDeviceId || !DEVICE_ID_PATTERN.test(clientDeviceId)) return null;
  if (platform !== "ios" && platform !== "android") return null;
  return { clientDeviceId, platform };
}

export async function touchNativeIapDevice(
  userId: string,
  client: { clientDeviceId: string; platform: NativeIapPlatform } | null,
): Promise<IapIntegrityDevice | null> {
  if (!client) return null;
  return await prisma.userDevice.upsert({
    where: {
      userId_clientDeviceId: {
        userId,
        clientDeviceId: client.clientDeviceId,
      },
    },
    create: {
      userId,
      clientDeviceId: client.clientDeviceId,
      platform: client.platform,
      lastSeenAt: new Date(),
    },
    update: {
      platform: client.platform,
      lastSeenAt: new Date(),
    },
    select: {
      lastIapIntegrityCheckedAt: true,
      lastIapIntegrityResult: true,
      lastIapIntegritySubscriptionUpdatedAt: true,
    },
  });
}

export function iapIntegrityForMe(
  user: Pick<User, "isPlanMismatch">,
  primary: PrimarySub,
  clientPlatform: NativeIapPlatform | null,
  device: IapIntegrityDevice | null,
  now = new Date(),
): MeDTO["iapIntegrity"] {
  const lastCheckedAt = device?.lastIapIntegrityCheckedAt ?? null;
  if (user.isPlanMismatch) {
    return {
      isPlanMismatch: true,
      requiresCheck: false,
      lastCheckedAt: lastCheckedAt?.toISOString() ?? null,
    };
  }

  const expectedSource = clientPlatform ? sourceForNativePlatform(clientPlatform) : null;
  const nativeSubNeedsThisDevice =
    !!primary && !!expectedSource && primary.source === expectedSource;
  const stale =
    !lastCheckedAt ||
    now.getTime() - lastCheckedAt.getTime() > IAP_INTEGRITY_CHECK_INTERVAL_MS;
  const subscriptionChanged =
    !!primary &&
    (!device?.lastIapIntegritySubscriptionUpdatedAt ||
      primary.updatedAt.getTime() >
        device.lastIapIntegritySubscriptionUpdatedAt.getTime());

  return {
    isPlanMismatch: false,
    requiresCheck: nativeSubNeedsThisDevice && (stale || subscriptionChanged),
    lastCheckedAt: lastCheckedAt?.toISOString() ?? null,
  };
}

export async function recordIapIntegrityResult(input: {
  userId: string;
  client: { clientDeviceId: string; platform: NativeIapPlatform };
  result: "matched" | "mismatched";
  primary: PrimarySub;
}): Promise<void> {
  const now = new Date();
  const expectedSource = sourceForNativePlatform(input.client.platform);
  if (!input.primary || input.primary.source !== expectedSource) {
    const deviceWrite = prisma.userDevice.upsert({
      where: {
        userId_clientDeviceId: {
          userId: input.userId,
          clientDeviceId: input.client.clientDeviceId,
        },
      },
      create: {
        userId: input.userId,
        clientDeviceId: input.client.clientDeviceId,
        platform: input.client.platform,
        lastSeenAt: now,
        lastIapIntegrityCheckedAt: now,
        lastIapIntegrityResult: input.result,
        lastIapIntegritySubscriptionUpdatedAt: input.primary?.updatedAt ?? null,
      },
      update: {
        platform: input.client.platform,
        lastSeenAt: now,
        lastIapIntegrityCheckedAt: now,
        lastIapIntegrityResult: input.result,
        lastIapIntegritySubscriptionUpdatedAt: input.primary?.updatedAt ?? null,
      },
    });
    if (input.result === "mismatched") {
      await prisma.$transaction([
        deviceWrite,
        prisma.user.update({
          where: { id: input.userId },
          data: { isPlanMismatch: true },
        }),
      ]);
      return;
    }
    await deviceWrite;
    return;
  }

  await prisma.$transaction([
    prisma.userDevice.upsert({
      where: {
        userId_clientDeviceId: {
          userId: input.userId,
          clientDeviceId: input.client.clientDeviceId,
        },
      },
      create: {
        userId: input.userId,
        clientDeviceId: input.client.clientDeviceId,
        platform: input.client.platform,
        lastSeenAt: now,
        lastIapIntegrityCheckedAt: now,
        lastIapIntegrityResult: input.result,
        lastIapIntegritySubscriptionUpdatedAt: input.primary.updatedAt,
      },
      update: {
        platform: input.client.platform,
        lastSeenAt: now,
        lastIapIntegrityCheckedAt: now,
        lastIapIntegrityResult: input.result,
        lastIapIntegritySubscriptionUpdatedAt: input.primary.updatedAt,
      },
    }),
    ...(input.result === "mismatched"
      ? [
          prisma.user.update({
            where: { id: input.userId },
            data: { isPlanMismatch: true },
          }),
        ]
      : []),
  ]);
}
