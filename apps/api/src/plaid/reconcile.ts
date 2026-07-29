import type { PlaidItemStatus, SubscriptionStatus } from "@prisma/client";
import { tierForIapProductId } from "@fina/shared";
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { effectiveTier } from "../auth/tier.js";
import { logError } from "../logger.js";
import { sanitizePlaidError } from "./client.js";
import { removeItemForBilling } from "./items.js";
import { stripeClient } from "../stripe/client.js";
import { syncSubscriptionFromStripe } from "../stripe/sync-sub.js";
import { requireAppleIapEnv, requireGoogleReceiptIapEnv } from "../iap/env-guard.js";
import { AppleClient } from "../iap/apple-client.js";
import { GoogleClient } from "../iap/google-client.js";
import { filterEnvironmentRows } from "../billing/precedence.js";

export type ReconcileResult = {
  kept: string[];
  disconnected: string[];
  failed: Array<{ id: string; error: unknown }>;
};

const billableStatuses: PlaidItemStatus[] = ["active", "error", "relink_required"];
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

export async function refreshBillingStateForUser(env: Env, userId: string): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { stripeCustomerId: true },
  });

  if (user.stripeCustomerId) {
    const stripe = stripeClient(env);
    const subs = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: "all",
      limit: 10,
    });
    for (const sub of subs.data) {
      await syncSubscriptionFromStripe(env, sub.id, userId);
    }
  }

  const iapRows = await prisma.subscription.findMany({
    where: {
      userId,
      source: { in: ["iap_apple", "iap_google"] },
      status: { in: refreshableIapStatuses },
    },
    select: {
      id: true,
      source: true,
      sourceSubscriptionId: true,
      environment: true,
    },
  });
  const refreshableIapRows = filterEnvironmentRows(iapRows, runtimeBillingEnv());

  let appleClient: AppleClient | null = null;
  let googleClient: GoogleClient | null = null;

  for (const row of refreshableIapRows) {
    if (row.source === "iap_apple") {
      appleClient ??= new AppleClient(requireAppleIapEnv(process.env));
      const status = await appleClient.getSubscriptionStatus(row.sourceSubscriptionId);
      const tier = tierForIapProductId(status.productId);
      const pendingTier = status.pendingProductId ? tierForIapProductId(status.pendingProductId) : null;
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
    const pendingTier = purchase.pendingProductId ? tierForIapProductId(purchase.pendingProductId) : null;
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
}

export async function reconcilePlaidItemsForUser(env: Env, userId: string): Promise<ReconcileResult> {
  const tier = await effectiveTier(userId);
  const rows = await prisma.plaidItem.findMany({
    where: {
      connectedBy: userId,
      status: { in: billableStatuses },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      workspaceId: true,
      workspace: {
        select: {
          memberships: {
            where: { userId },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });

  const valid: typeof rows = [];
  const invalidMembership: typeof rows = [];
  for (const row of rows) {
    if (row.workspace.memberships.length === 0) invalidMembership.push(row);
    else valid.push(row);
  }

  const keep = new Set(valid.slice(0, tier.plaidItemLimit).map((row) => row.id));
  const toDisconnect = [
    ...invalidMembership.map((row) => ({ row, reconnectRequired: false })),
    ...valid
      .filter((row) => !keep.has(row.id))
      .map((row) => ({ row, reconnectRequired: true })),
  ];

  const result: ReconcileResult = { kept: Array.from(keep), disconnected: [], failed: [] };
  for (const { row, reconnectRequired } of toDisconnect) {
    try {
      await removeItemForBilling(env, row.workspaceId, row.id, {
        reconnectRequired,
      });
      result.disconnected.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, error });
      logError({ plaidItemId: row.id, err: sanitizePlaidError(error) }, "plaid reconciliation disconnect failed");
    }
  }
  return result;
}

export async function reconcileOrphanPlaidItems(env: Env): Promise<ReconcileResult> {
  const rows = await prisma.plaidItem.findMany({
    where: {
      connectedBy: null,
      status: { not: "disconnected" },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      workspaceId: true,
    },
  });

  const result: ReconcileResult = { kept: [], disconnected: [], failed: [] };
  for (const row of rows) {
    try {
      await removeItemForBilling(env, row.workspaceId, row.id, {
        reconnectRequired: false,
      });
      result.disconnected.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, error });
      logError({ plaidItemId: row.id, err: sanitizePlaidError(error) }, "orphan plaid reconciliation disconnect failed");
    }
  }
  return result;
}

export async function retryPendingPlaidBillingCleanups(env: Env): Promise<ReconcileResult> {
  const rows = await prisma.plaidItem.findMany({
    // Also sweep legacy "disconnected" rows created by the old downgrade
    // behavior, which stopped syncing but retained the encrypted Plaid item.
    // ITEM_NOT_FOUND is treated as success, so these are safe to delete even
    // when Plaid was already removed months ago.
    where: { status: "disconnected" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, workspaceId: true },
  });

  const result: ReconcileResult = { kept: [], disconnected: [], failed: [] };
  for (const row of rows) {
    try {
      await removeItemForBilling(env, row.workspaceId, row.id);
      result.disconnected.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, error });
      logError({ plaidItemId: row.id, err: sanitizePlaidError(error) }, "pending plaid cleanup retry failed");
    }
  }
  return result;
}
