import { Expo, type ExpoPushReceipt } from "expo-server-sdk";
import { prisma } from "../../db.js";
import { logError, logInfo, logWarn } from "../../logger.js";
import type { Env } from "../../env.js";

const CRON_NAME = "push-receipts";

/** Polls Expo for receipts of tickets sent >= 1 hour ago. Handles
 *  DeviceNotRegistered (cascading UserDevice delete), InvalidCredentials
 *  (critical structured log), other errors (warn + errorCode). Receipts
 *  not yet ready leave polledAt null for the next tick. */
export async function runPushReceipts(env: Env): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const pending = await prisma.pushTicket.findMany({
    where: { polledAt: null, sentAt: { lt: oneHourAgo } },
    orderBy: { sentAt: "asc" },  // FIFO; prevents starvation under flood
    take: 200,
    select: { id: true, expoTicketId: true, userDeviceId: true },
  });
  if (pending.length === 0) return;

  // expo-server-sdk does NOT auto-chunk getPushNotificationReceiptsAsync.
  // Receipt chunk limit is 300; our take:200 stays under. If raised, call
  // expo.chunkPushNotificationReceiptIds(ids) first.
  const expo = new Expo(
    env.EXPO_ACCESS_TOKEN === undefined ? {} : { accessToken: env.EXPO_ACCESS_TOKEN },
  );

  let receipts: Record<string, ExpoPushReceipt>;
  try {
    receipts = await expo.getPushNotificationReceiptsAsync(pending.map((t) => t.expoTicketId));
  } catch (err) {
    logError({ cron: CRON_NAME, err }, "expo getReceipts threw");
    return;  // next tick retries
  }

  let polled = 0;
  let failed = 0;
  let invalidCreds = false;
  // Same-batch cascade guard: if ticket A's DNR receipt deletes UserDevice X,
  // any later ticket pointing to X has been cascade-deleted. Skip those.
  const deletedDeviceIds = new Set<string>();

  for (const ticket of pending) {
    if (deletedDeviceIds.has(ticket.userDeviceId)) continue;

    const r = receipts[ticket.expoTicketId];
    if (!r) continue;  // Expo doesn't have receipt yet — next tick retries

    polled++;
    if (r.status === "ok") {
      await prisma.pushTicket.update({
        where: { id: ticket.id },
        data: { polledAt: new Date(), status: "ok" },
      });
      continue;
    }

    failed++;
    const errorCode = r.details?.error ?? "Unknown";

    if (errorCode === "DeviceNotRegistered") {
      // Spec §5 shows .delete; we use .deleteMany — same FK CASCADE, but
      // idempotent. UserDevice may already be gone if sendBriefPush's own
      // DNR handler or 2C-push-cleanup's sign-out DELETE fired between
      // send and poll; .delete would throw P2025.
      await prisma.userDevice.deleteMany({ where: { id: ticket.userDeviceId } });
      deletedDeviceIds.add(ticket.userDeviceId);
      logInfo(
        { cron: CRON_NAME, removedDeviceId: ticket.userDeviceId, receiptErrorCode: errorCode },
        "device removed via receipt",
      );
      continue;
    }

    await prisma.pushTicket.update({
      where: { id: ticket.id },
      data: { polledAt: new Date(), status: "error", errorCode },
    });

    if (errorCode === "InvalidCredentials") {
      invalidCreds = true;
      logError(
        { cron: CRON_NAME, receiptInvalidCreds: true, receiptErrorCode: errorCode, err: r.message },
        "APNs/FCM credentials invalid — operator action required",
      );
    } else {
      logWarn(
        { cron: CRON_NAME, receiptErrorCode: errorCode, err: r.message },
        "receipt error",
      );
    }
  }

  logInfo(
    {
      cron: CRON_NAME,
      receiptsPolled: polled,
      receiptsFailed: failed,
      ...(invalidCreds ? { receiptInvalidCreds: true } : {}),
    },
    "receipts cron done",
  );
}
