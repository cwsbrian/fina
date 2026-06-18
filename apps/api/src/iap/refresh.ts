import type { SubscriptionStatus } from "@prisma/client";
import { tierForIapProductId } from "@fina/shared";
import { prisma } from "../db.js";
import { filterEnvironmentRows } from "../billing/precedence.js";
import { HttpError } from "../auth/context.js";
import { requireAppleIapEnv, requireGoogleReceiptIapEnv } from "./env-guard.js";
import { AppleClient } from "./apple-client.js";
import { GoogleClient } from "./google-client.js";

const refreshableIapStatuses: SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "paused",
  "incomplete",
];

function runtimeBillingEnv(): "sandbox" | "production" {
  return process.env.APPLE_ENV === "production" ? "production" : "sandbox";
}

type AppleRefreshClient = Pick<AppleClient, "getSubscriptionStatus">;
type GoogleRefreshClient = Pick<GoogleClient, "fetchAndNormalize" | "acknowledgeIfPending">;

function isMissingAppleTransactionError(e: unknown): boolean {
  return (
    e instanceof HttpError &&
    e.code === "invalid_receipt" &&
    /asc no transaction/i.test(e.message)
  );
}

export type RefreshDueIapOptions = {
  now?: Date;
  appleClient?: AppleRefreshClient;
  googleClient?: GoogleRefreshClient;
};

export async function refreshDueIapSubscriptionsForUser(
  userId: string,
  opts: RefreshDueIapOptions = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const dueRows = await prisma.subscription.findMany({
    where: {
      userId,
      source: { in: ["iap_apple", "iap_google"] },
      status: { in: refreshableIapStatuses },
      OR: [{ currentPeriodEnd: { lte: now } }, { pendingTierAt: { lte: now } }],
    },
    select: {
      id: true,
      source: true,
      sourceSubscriptionId: true,
      environment: true,
    },
  });
  const rows = filterEnvironmentRows(dueRows, runtimeBillingEnv());

  let appleClient = opts.appleClient ?? null;
  let googleClient = opts.googleClient ?? null;

  for (const row of rows) {
    if (row.source === "iap_apple") {
      appleClient ??= new AppleClient(requireAppleIapEnv(process.env));
      const status = await appleClient.getSubscriptionStatus(row.sourceSubscriptionId).catch(async (e) => {
        if (!isMissingAppleTransactionError(e)) throw e;
        await prisma.subscription.update({
          where: { id: row.id },
          data: {
            status: "canceled",
            currentPeriodEnd: now,
            cancelAtPeriodEnd: false,
            pendingTier: null,
            pendingTierAt: null,
          },
        });
        return null;
      });
      if (!status) continue;
      const tier = tierForIapProductId(status.productId);
      const pendingTier = status.pendingProductId
        ? tierForIapProductId(status.pendingProductId)
        : null;
      await prisma.subscription.update({
        where: { id: row.id },
        data: {
          ...(tier ? { tier } : {}),
          status: status.mapped.status as SubscriptionStatus,
          currentPeriodEnd: status.expiresDate,
          cancelAtPeriodEnd: status.mapped.cancelAtPeriodEnd,
          pendingTier,
          pendingTierAt: pendingTier ? (status.pendingAt ?? status.expiresDate) : null,
        },
      });
      continue;
    }

    googleClient ??= new GoogleClient(requireGoogleReceiptIapEnv(process.env));
    const purchase = await googleClient.fetchAndNormalize(row.sourceSubscriptionId);
    const tier = tierForIapProductId(purchase.productId);
    const pendingTier = purchase.pendingProductId
      ? tierForIapProductId(purchase.pendingProductId)
      : null;
    await prisma.subscription.update({
      where: { id: row.id },
      data: {
        ...(tier ? { tier } : {}),
        status: purchase.mapped.status as SubscriptionStatus,
        currentPeriodEnd: purchase.expiryTime,
        cancelAtPeriodEnd: purchase.mapped.cancelAtPeriodEnd,
        pendingTier,
        pendingTierAt: pendingTier ? (purchase.pendingAt ?? purchase.expiryTime) : null,
        environment: purchase.environment,
      },
    });
    await googleClient.acknowledgeIfPending({
      purchaseToken: row.sourceSubscriptionId,
      productId: purchase.productId,
      acknowledgementState: purchase.acknowledgementState,
    });
  }

  return rows.length;
}
