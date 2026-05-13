import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { plaidClient, sanitizePlaidError } from "./client.js";
import { readAccessToken } from "./items.js";

/**
 * One-shot startup task: ensure every active Plaid item has its current
 * PLAID_WEBHOOK_URL registered with Plaid. Runs items whose webhookUrl is
 * null (initial backfill) or differs from env.PLAID_WEBHOOK_URL (URL rotation
 * or domain migration).
 *
 * Best-effort: failures are logged, not thrown — startup must not be blocked
 * by a transient Plaid hiccup.
 */
export async function backfillWebhookUrls(env: Env): Promise<void> {
  if (!env.PLAID_WEBHOOK_URL) {
    console.warn("backfillWebhookUrls: PLAID_WEBHOOK_URL not set, skipping");
    return;
  }
  const wantUrl = env.PLAID_WEBHOOK_URL;

  const items = await prisma.plaidItem.findMany({
    where: {
      status: "active",
      OR: [{ webhookUrl: null }, { webhookUrl: { not: wantUrl } }],
    },
    select: { id: true, workspaceId: true, itemId: true },
  });

  for (const item of items) {
    try {
      const { accessToken } = await readAccessToken(env, item.workspaceId, item.id);
      await plaidClient(env).itemWebhookUpdate({
        access_token: accessToken,
        webhook: wantUrl,
      });
      await prisma.plaidItem.update({
        where: { id: item.id },
        data: { webhookUrl: wantUrl },
      });
    } catch (e) {
      // sanitizePlaidError strips axios request config (which contains access_token)
      // from the logged object, preventing accidental token leakage in logs.
      console.error("backfillWebhookUrls: failed for item", { itemId: item.id, err: sanitizePlaidError(e) });
    }
  }
}
