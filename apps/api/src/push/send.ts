import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { prisma } from "../db.js";
import { logInfo, logWarn, logError } from "../logger.js";
import type { Env } from "../env.js";

/** Carrier-message: ExpoPushMessage extended with our DB row id so the
 *  receipt-error handler knows which UserDevice to delete on
 *  DeviceNotRegistered. Expo's SDK ignores extra properties. */
type CarrierMessage = ExpoPushMessage & { __deviceId: string };

/** Result of one push send pass for a single user. */
export type PushSendResult = { sent: number; failed: number };

/** Send the daily brief preview to all of `userId`'s registered devices.
 *  Fire-and-forget — catches its own errors. Returns counts for logging.
 *
 *  Cleans up stale tokens inline: a DeviceNotRegistered ticket triggers
 *  deletion of the UserDevice row so the next send doesn't retry. */
export async function sendBriefPush(
  env: Env,
  userId: string,
  briefText: string,
): Promise<PushSendResult> {
  const devices = await prisma.userDevice.findMany({ where: { userId } });
  if (devices.length === 0) {
    logInfo({ userId, deviceCount: 0 }, "push send skipped — no devices");
    return { sent: 0, failed: 0 };
  }

  // Omit the property entirely when unset — exactOptionalPropertyTypes won't
  // accept an undefined value for accessToken (the Expo client treats "no
  // token" as omission).
  const accessToken = env.EXPO_ACCESS_TOKEN;
  const expo = new Expo(accessToken === undefined ? {} : { accessToken });

  // Build carrier messages — filter out malformed tokens.
  const messages: CarrierMessage[] = [];
  for (const d of devices) {
    if (!Expo.isExpoPushToken(d.expoPushToken)) {
      logWarn({ userId, removedDeviceId: d.id }, "skipping malformed push token");
      continue;
    }
    messages.push({
      to: d.expoPushToken,
      title: "Fina ☀️",
      body: briefText,  // caller already truncated/cleaned via markdownToPlainPreview
      data: { type: "daily-brief" },
      sound: "default",
      priority: "high",
      __deviceId: d.id,
    });
  }

  if (messages.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const chunks = expo.chunkPushNotifications(messages);
  let sent = 0;
  let failed = 0;

  for (const chunk of chunks) {
    let tickets: ExpoPushTicket[];
    try {
      tickets = await expo.sendPushNotificationsAsync(chunk);
    } catch (err) {
      // Network / Expo outage — log and treat the whole chunk as failed but
      // don't delete tokens (the issue is transient).
      logError({ userId, err, deviceCount: chunk.length }, "expo send threw");
      failed += chunk.length;
      continue;
    }

    for (let i = 0; i < tickets.length; i++) {
      const t = tickets[i]!;
      const deviceId = (chunk[i] as CarrierMessage).__deviceId;

      if (t.status === "ok") {
        // Persist ok tickets for receipt polling (Plan 2C-push-receipts).
        // Best-effort: a failure here shouldn't break the whole send.
        try {
          await prisma.pushTicket.create({
            data: { expoTicketId: t.id, userDeviceId: deviceId },
          });
        } catch (err) {
          logWarn(
            { userId, removedDeviceId: deviceId, err },
            "ticket persist failed",
          );
        }
        sent++;
        continue;
      }
      failed++;
      const errorCode = t.details?.error;
      if (errorCode === "DeviceNotRegistered") {
        await prisma.userDevice.delete({ where: { id: deviceId } });
        logInfo({ userId, removedDeviceId: deviceId }, "stale device removed");
      } else {
        // Other errors (MessageRateExceeded, InvalidCredentials, ...) — log
        // and continue. Don't delete; transient issue.
        logWarn(
          { userId, removedDeviceId: deviceId, err: t.message },
          "push send error (token kept)",
        );
      }
    }
  }

  logInfo({ userId, deviceCount: devices.length, pushSent: sent, pushFailed: failed }, "push send done");
  return { sent, failed };
}
