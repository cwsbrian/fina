import { prisma } from "../db.js";

type ItemBody = {
  webhook_code: string;
  error?: { error_code?: string | null } | null;
};

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
      break;
    case "PENDING_EXPIRATION":
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { status: "relink_required", errorCode: null },
      });
      break;
    case "USER_PERMISSION_REVOKED":
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { status: "disconnected", errorCode: null },
      });
      break;
    default:
      console.info("ITEM webhook ignored", { itemId: item.id, code: body.webhook_code });
  }
}
