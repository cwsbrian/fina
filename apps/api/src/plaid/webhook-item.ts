import { prisma } from "../db.js";
import { logInfo, logError } from "../logger.js";
import { sendBankReconnectPush } from "../push/send.js";
import type { Env } from "../env.js";

type ItemBody = {
  webhook_code: string;
  error?: { error_code?: string | null } | null;
};

/** Push the bank-reconnect notification to every owner-or-editor of
 *  the workspace that owns this Plaid item. Best-effort, errors
 *  swallowed — the status row is already updated regardless. */
async function notifyReconnectNeeded(
  env: Env,
  plaidItemId: string,
): Promise<void> {
  try {
    const item = await prisma.plaidItem.findUnique({
      where: { id: plaidItemId },
      select: {
        institutionName: true,
        workspace: {
          select: {
            memberships: {
              where: { role: { in: ["owner", "editor"] } },
              select: { userId: true },
            },
          },
        },
      },
    });
    if (!item) return;
    // Per-recipient try/catch: a transient error on one member must NOT
    // drop the tail of the fan-out (per Plan 1U / 1V).
    for (const m of item.workspace.memberships) {
      try {
        await sendBankReconnectPush(env, m.userId, item.institutionName);
      } catch (err) {
        logError(
          { plaidItemId, recipientUserId: m.userId, err },
          "bank-reconnect push to recipient failed",
        );
      }
    }
  } catch (err) {
    logError(
      { plaidItemId, err },
      "bank reconnect push send failed (status update already persisted)",
    );
  }
}

/**
 * Dispatcher for Plaid ITEM-type webhooks. Updates plaid_items.status to
 * reflect real-world reconnect/disconnect/error state. Never throws — caller
 * uses void + .catch() so the webhook handler always returns 200.
 *
 * Unhandled codes (WEBHOOK_UPDATE_ACKNOWLEDGED, future codes) are logged and
 * ignored — no DB write.
 */
export async function dispatchItemEvent(
  item: { id: string },
  body: ItemBody,
  env: Env,
): Promise<void> {
  switch (body.webhook_code) {
    case "ERROR":
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: {
          status: "error",
          errorCode: body.error?.error_code ?? "unknown",
        },
      });
      // Most "ERROR" events are transient (rate limits, plaid blips) and
      // shouldn't push the user. Only ITEM_LOGIN_REQUIRED means real
      // reconnect work.
      if (body.error?.error_code === "ITEM_LOGIN_REQUIRED") {
        await notifyReconnectNeeded(env, item.id);
      }
      break;
    case "PENDING_EXPIRATION":
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { status: "relink_required", errorCode: null },
      });
      await notifyReconnectNeeded(env, item.id);
      break;
    case "USER_PERMISSION_REVOKED":
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { status: "disconnected", errorCode: null },
      });
      break;
    default:
      logInfo(
        { plaidItemId: item.id, plaidEvent: body.webhook_code },
        "ITEM webhook ignored",
      );
  }
}
