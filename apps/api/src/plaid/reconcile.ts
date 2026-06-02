import type { PlaidItemStatus } from "@prisma/client";
import type { Env } from "../env.js";
import { prisma } from "../db.js";
import { effectiveTier } from "../auth/tier.js";
import { logError } from "../logger.js";
import { sanitizePlaidError } from "./client.js";
import { removeItemForBilling } from "./items.js";

export type ReconcileResult = {
  kept: string[];
  disconnected: string[];
  failed: Array<{ id: string; error: unknown }>;
};

const billableStatuses: PlaidItemStatus[] = ["active", "error", "relink_required"];

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
    ...invalidMembership,
    ...valid.filter((row) => !keep.has(row.id)),
  ];

  const result: ReconcileResult = { kept: Array.from(keep), disconnected: [], failed: [] };
  for (const row of toDisconnect) {
    try {
      await removeItemForBilling(env, row.workspaceId, row.id);
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
      status: { in: billableStatuses },
    },
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
      logError({ plaidItemId: row.id, err: sanitizePlaidError(error) }, "orphan plaid reconciliation disconnect failed");
    }
  }
  return result;
}

export async function retryPendingPlaidBillingCleanups(env: Env): Promise<ReconcileResult> {
  const rows = await prisma.plaidItem.findMany({
    where: { status: "disconnected", errorCode: "billing_cleanup_pending" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, workspaceId: true },
  });

  const result: ReconcileResult = { kept: [], disconnected: [], failed: [] };
  for (const row of rows) {
    try {
      await removeItemForBilling(env, row.workspaceId, row.id);
      await prisma.plaidItem.update({ where: { id: row.id }, data: { errorCode: null } });
      result.disconnected.push(row.id);
    } catch (error) {
      result.failed.push({ id: row.id, error });
      logError({ plaidItemId: row.id, err: sanitizePlaidError(error) }, "pending plaid cleanup retry failed");
    }
  }
  return result;
}
