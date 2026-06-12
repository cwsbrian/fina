import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { prisma } from "../db.js";
import { logInfo, logWarn, logError } from "../logger.js";
import {
  resolveNotificationPrefs,
  type NotificationPrefs,
} from "@fina/shared";
import type { Env } from "../env.js";

/** Read the user's notification prefs and return whether the given
 *  channel is enabled. Missing user or unset prefs use the defaults. */
async function isChannelEnabled(
  userId: string,
  channel: keyof NotificationPrefs,
): Promise<boolean> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  if (!u) return false;
  return resolveNotificationPrefs(u.notificationPrefs)[channel];
}

/** Carrier-message: ExpoPushMessage extended with our DB row id so the
 *  receipt-error handler knows which UserDevice to delete on
 *  DeviceNotRegistered. Expo's SDK ignores extra properties. */
type CarrierMessage = ExpoPushMessage & { __deviceId: string };

/** Result of one push send pass for a single user. */
export type PushSendResult = { sent: number; failed: number };

type PushPayload = {
  title: string;
  body: string;
  /** Goes into the notification's data blob; mobile uses it to route
   *  the user to the right screen when they tap. */
  dataType: string;
};

/** Core send helper. Filters out registered devices into one Expo
 *  request, persists ok tickets for the receipt-polling cron, deletes
 *  stale-token devices, and returns send/fail counts. Used by the
 *  per-channel wrappers below — they handle pref gating + copy. */
async function sendToUserDevices(
  env: Env,
  userId: string,
  payload: PushPayload,
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
    if (!d.expoPushToken) continue;
    if (!Expo.isExpoPushToken(d.expoPushToken)) {
      logWarn({ userId, removedDeviceId: d.id }, "skipping malformed push token");
      continue;
    }
    messages.push({
      to: d.expoPushToken,
      title: payload.title,
      body: payload.body,
      data: { type: payload.dataType },
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

  logInfo(
    { userId, deviceCount: devices.length, pushSent: sent, pushFailed: failed, channel: payload.dataType },
    "push send done",
  );
  return { sent, failed };
}

/** Send the daily brief preview to all of `userId`'s registered devices.
 *  Fire-and-forget — catches its own errors. Skips when the user
 *  disabled the morningBrief channel. */
export async function sendBriefPush(
  env: Env,
  userId: string,
  briefText: string,
): Promise<PushSendResult> {
  if (!(await isChannelEnabled(userId, "morningBrief"))) {
    logInfo({ userId, channel: "morningBrief" }, "push skipped — channel disabled");
    return { sent: 0, failed: 0 };
  }
  return sendToUserDevices(env, userId, {
    title: "Fina ☀️",
    body: briefText,
    dataType: "daily-brief",
  });
}

/** Plaid item entered relink_required / error. Tell the user so they
 *  can reconnect before sync silently drifts. */
export async function sendBankReconnectPush(
  env: Env,
  userId: string,
  institutionName: string,
): Promise<PushSendResult> {
  if (!(await isChannelEnabled(userId, "bankReconnect"))) {
    logInfo({ userId, channel: "bankReconnect" }, "push skipped — channel disabled");
    return { sent: 0, failed: 0 };
  }
  return sendToUserDevices(env, userId, {
    title: "Reconnect your bank",
    body: `${institutionName} stopped syncing. Open Fina to reconnect.`,
    dataType: "bank-reconnect",
  });
}

/** Pro trial within 5 / 3 / 1 days of ending. Cron picks the day. */
export async function sendTrialExpiringPush(
  env: Env,
  userId: string,
  daysLeft: number,
): Promise<PushSendResult> {
  if (!(await isChannelEnabled(userId, "trialExpiring"))) {
    logInfo({ userId, channel: "trialExpiringPush" }, "push skipped — channel disabled");
    return { sent: 0, failed: 0 };
  }
  const label =
    daysLeft === 1 ? "Your trial ends tomorrow" : `Your trial ends in ${daysLeft} days`;
  return sendToUserDevices(env, userId, {
    title: label,
    body: "Pick a plan to keep Plaid sync, chat, and the morning brief running.",
    dataType: "trial-expiring",
  });
}

/** Crossed a 25 / 50 / 75 / 100 milestone on a savings goal. */
export async function sendGoalMilestonePush(
  env: Env,
  userId: string,
  goalTitle: string,
  pct: number,
): Promise<PushSendResult> {
  if (!(await isChannelEnabled(userId, "goalMilestones"))) {
    logInfo({ userId, channel: "goalMilestones" }, "push skipped — channel disabled");
    return { sent: 0, failed: 0 };
  }
  const title =
    pct >= 100 ? `Goal complete: ${goalTitle}` : `${pct}% there on ${goalTitle}`;
  const body =
    pct >= 100
      ? "Nice. Open Fina to see what's next."
      : "Keep going. Tap to see what's funding it.";
  return sendToUserDevices(env, userId, {
    title,
    body,
    dataType: "goal-milestone",
  });
}

/** A new transaction looks unusually large vs the category's recent
 *  baseline. Anomaly detection lives in apps/api/src/push/anomaly.ts. */
export async function sendLargeChargePush(
  env: Env,
  userId: string,
  merchant: string,
  amount: string,
  categoryName: string | null,
): Promise<PushSendResult> {
  if (!(await isChannelEnabled(userId, "largeCharges"))) {
    logInfo({ userId, channel: "largeCharges" }, "push skipped — channel disabled");
    return { sent: 0, failed: 0 };
  }
  const where = categoryName ? ` for ${categoryName}` : "";
  return sendToUserDevices(env, userId, {
    title: `Unusual charge: $${amount}`,
    body: `${merchant}${where} is well above your usual.`,
    dataType: "large-charge",
  });
}

/** Generic "new transaction" push, sent per-tx to workspace members
 *  (excluding the creator on manual entry — caller filters). */
export async function sendTransactionAddedPush(
  env: Env,
  userId: string,
  merchant: string,
  amount: string,
  categoryName: string | null,
): Promise<PushSendResult> {
  if (!(await isChannelEnabled(userId, "transactionAdded"))) {
    logInfo({ userId, channel: "transactionAdded" }, "push skipped — channel disabled");
    return { sent: 0, failed: 0 };
  }
  const where = categoryName ? ` · ${categoryName}` : "";
  return sendToUserDevices(env, userId, {
    title: `${merchant} · $${amount}`,
    body: `New transaction${where}`,
    dataType: "transaction-added",
  });
}

/** Sparse marketing — new features, tips. Caller chooses copy. */
export async function sendProductUpdatePush(
  env: Env,
  userId: string,
  title: string,
  body: string,
): Promise<PushSendResult> {
  if (!(await isChannelEnabled(userId, "productUpdates"))) {
    logInfo({ userId, channel: "productUpdates" }, "push skipped — channel disabled");
    return { sent: 0, failed: 0 };
  }
  return sendToUserDevices(env, userId, {
    title,
    body,
    dataType: "product-update",
  });
}

/** Someone with an existing account was invited to a workspace. */
export async function sendWorkspaceInvitePush(
  env: Env,
  userId: string,
  inviterName: string,
  workspaceName: string,
): Promise<PushSendResult> {
  if (!(await isChannelEnabled(userId, "workspaceInvites"))) {
    logInfo({ userId, channel: "workspaceInvites" }, "push skipped — channel disabled");
    return { sent: 0, failed: 0 };
  }
  return sendToUserDevices(env, userId, {
    title: "Workspace invite",
    body: `${inviterName} invited you to ${workspaceName}.`,
    dataType: "workspace-invite",
  });
}
