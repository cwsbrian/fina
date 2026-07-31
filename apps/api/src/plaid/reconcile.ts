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
import { categorizeNewTransactions } from "../categorize/service.js";

export type ReconcileResult = {
  kept: string[];
  disconnected: string[];
  failed: Array<{ id: string; error: unknown }>;
};

const billableStatuses: PlaidItemStatus[] = ["active", "error", "relink_required"];
export const PLAID_BILLING_GRACE_DAYS = 30;
const PLAID_BILLING_GRACE_MS = PLAID_BILLING_GRACE_DAYS * 86_400_000;
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
  const now = new Date();
  const rows = await prisma.plaidItem.findMany({
    where: {
      connectedBy: userId,
      status: { in: billableStatuses },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      workspaceId: true,
      billingGraceEndsAt: true,
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

  const result: ReconcileResult = { kept: [], disconnected: [], failed: [] };
  const disconnect = async (
    row: (typeof rows)[number],
    reconnectRequired: boolean,
  ): Promise<void> => {
    try {
      await removeItemForBilling(env, row.workspaceId, row.id, {
        reconnectRequired,
        deleteGraceHiddenTransactions: true,
      });
      result.disconnected.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, error });
      logError(
        { plaidItemId: row.id, err: sanitizePlaidError(error) },
        "plaid reconciliation disconnect failed",
      );
    }
  };

  // Losing workspace access is not a billing downgrade and must revoke the
  // connection immediately regardless of grace state.
  for (const row of invalidMembership) await disconnect(row, false);

  if (tier.plaidItemLimit <= 0) {
    for (const row of valid) {
      if (row.billingGraceEndsAt === null) {
        await prisma.plaidItem.updateMany({
          where: { id: row.id, billingGraceEndsAt: null },
          data: { billingGraceEndsAt: new Date(now.getTime() + PLAID_BILLING_GRACE_MS) },
        });
        result.kept.push(row.id);
        continue;
      }
      if (row.billingGraceEndsAt > now) {
        result.kept.push(row.id);
        continue;
      }
      await disconnect(row, true);
    }
    return result;
  }

  const keep = new Set(valid.slice(0, tier.plaidItemLimit).map((row) => row.id));
  for (const row of valid) {
    if (!keep.has(row.id)) {
      await disconnect(row, true);
      continue;
    }
    if (row.billingGraceEndsAt !== null) {
      const hiddenTransactions = await prisma.transaction.findMany({
        where: { plaidItemId: row.id, billingGraceHiddenAt: { not: null } },
        select: { id: true },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      });
      await prisma.$transaction([
        prisma.transaction.updateMany({
          where: { plaidItemId: row.id, billingGraceHiddenAt: { not: null } },
          data: { billingGraceHiddenAt: null, removedAt: null },
        }),
        prisma.plaidItem.update({
          where: { id: row.id },
          data: { billingGraceEndsAt: null },
        }),
      ]);
      await categorizeNewTransactions(
        env,
        row.workspaceId,
        hiddenTransactions.map((transaction) => transaction.id),
      ).catch((error) => {
        logError(
          { plaidItemId: row.id, err: error },
          "categorize restored billing-grace transactions failed",
        );
      });
    }
    result.kept.push(row.id);
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
        deleteGraceHiddenTransactions: true,
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
