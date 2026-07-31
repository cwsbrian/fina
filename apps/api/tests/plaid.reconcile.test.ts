import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { plaidMock, resetPlaidMock } from "./helpers/plaid-mock.js";

const { plaidMockFactory: hoistedPlaidMockFactory } = await vi.hoisted(
  async () => await import("./helpers/plaid-mock.js"),
);
vi.mock("plaid", hoistedPlaidMockFactory);

import { prisma } from "../src/db.js";
import {
  reconcilePlaidItemsForUser,
  reconcileOrphanPlaidItems,
  retryPendingPlaidBillingCleanups,
} from "../src/plaid/reconcile.js";
import { storeAccessToken } from "../src/plaid/items.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

async function userWithTrial(email: string, trialEndsAt: Date | null) {
  return prisma.user.create({
    data: { id: randomUUID(), email, name: email, trialEndsAt },
  });
}

async function workspaceForOwner(userId: string) {
  return prisma.workspace.create({
    data: {
      name: "Test workspace",
      memberships: { create: { userId, role: "owner" } },
    },
  });
}

async function item(opts: { workspaceId: string; connectedBy: string | null; createdAt: Date; itemId: string }) {
  const id = await storeAccessToken(env, prisma, {
    workspaceId: opts.workspaceId,
    connectedBy: opts.connectedBy,
    itemId: opts.itemId,
    institutionId: "ins",
    institutionName: opts.itemId,
    accessToken: `access-${opts.itemId}`,
  });
  const row = await prisma.plaidItem.update({
    where: { id },
    data: { createdAt: opts.createdAt },
  });
  await prisma.bankAccount.create({
    data: {
      workspaceId: opts.workspaceId,
      plaidItemId: row.id,
      plaidAccountId: `${opts.itemId}_acct`,
      name: opts.itemId,
      type: "depository",
      currency: "CAD",
    },
  });
  return row;
}

beforeEach(async () => {
  resetPlaidMock();
  await truncateAll();
});

afterAll(async () => {
  await disconnect();
});

describe("reconcilePlaidItemsForUser", () => {
  it("pro keeps user-owned items below the 5-item cap", async () => {
    const u = await userWithTrial("pro@example.com", null);
    await prisma.subscription.create({
      data: {
        userId: u.id,
        tier: "pro",
        source: "stripe",
        sourceSubscriptionId: "sub_pro_under_cap",
        status: "active",
        currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      },
    });
    const ws = await workspaceForOwner(u.id);
    const first = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "first" });
    const second = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-02T00:00:00Z"), itemId: "second" });

    const result = await reconcilePlaidItemsForUser(env, u.id);

    expect(result.kept).toEqual([first.id, second.id]);
    expect(result.disconnected).toEqual([]);
    await expect(prisma.plaidItem.findUniqueOrThrow({ where: { id: first.id } })).resolves.toMatchObject({ status: "active" });
    await expect(prisma.plaidItem.findUniqueOrThrow({ where: { id: second.id } })).resolves.toMatchObject({ status: "active" });
  });

  it("does not count another member's item against the user", async () => {
    const owner = await userWithTrial("owner@example.com", null);
    const other = await userWithTrial("other@example.com", null);
    await prisma.subscription.create({
      data: {
        userId: owner.id,
        tier: "pro",
        source: "stripe",
        sourceSubscriptionId: "sub_owner",
        status: "active",
        currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      },
    });
    const ws = await workspaceForOwner(owner.id);
    await prisma.membership.create({ data: { workspaceId: ws.id, userId: other.id, role: "editor" } });
    const owned = await item({ workspaceId: ws.id, connectedBy: owner.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "owned" });
    const others = await item({ workspaceId: ws.id, connectedBy: other.id, createdAt: new Date("2026-01-02T00:00:00Z"), itemId: "others" });

    const result = await reconcilePlaidItemsForUser(env, owner.id);

    expect(result.kept).toEqual([owned.id]);
    expect(result.disconnected).toEqual([]);
    await expect(prisma.plaidItem.findUniqueOrThrow({ where: { id: others.id } })).resolves.toMatchObject({ status: "active" });
  });

  it("disconnects items when connectedBy has no workspace membership", async () => {
    const u = await userWithTrial("left@example.com", null);
    const ws = await workspaceForOwner(u.id);
    await prisma.membership.deleteMany({ where: { userId: u.id, workspaceId: ws.id } });
    const stale = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "stale" });
    plaidMock.itemRemove.push({ data: { request_id: "remove-stale" } });

    const result = await reconcilePlaidItemsForUser(env, u.id);

    expect(result.disconnected).toEqual([stale.id]);
  });

  it("pro keeps earliest five and disconnects the sixth", async () => {
    const u = await userWithTrial("pro-limit@example.com", null);
    await prisma.subscription.create({
      data: {
        userId: u.id,
        tier: "pro",
        source: "stripe",
        sourceSubscriptionId: "sub_pro_limit",
        status: "active",
        currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      },
    });
    const ws = await workspaceForOwner(u.id);
    const rows = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        item({
          workspaceId: ws.id,
          connectedBy: u.id,
          createdAt: new Date(`2026-01-0${i + 1}T00:00:00Z`),
          itemId: `pro_${i}`,
        }),
      ),
    );
    plaidMock.itemRemove.push({ data: { request_id: "remove-sixth" } });

    const result = await reconcilePlaidItemsForUser(env, u.id);

    expect(result.kept).toEqual(rows.slice(0, 5).map((r) => r.id));
    expect(result.disconnected).toEqual([rows[5]!.id]);
  });

  it("canceled/free user starts a 30-day grace period without disconnecting", async () => {
    const u = await userWithTrial("free@example.com", null);
    await prisma.subscription.create({
      data: {
        userId: u.id,
        tier: "max",
        source: "stripe",
        sourceSubscriptionId: "sub_canceled",
        status: "canceled",
        currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      },
    });
    const ws = await workspaceForOwner(u.id);
    const first = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "free_a" });
    const second = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-02T00:00:00Z"), itemId: "free_b" });
    const before = Date.now();
    const result = await reconcilePlaidItemsForUser(env, u.id);

    expect(result.kept.sort()).toEqual([first.id, second.id].sort());
    expect(result.disconnected).toEqual([]);
    const graceItems = await prisma.plaidItem.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { billingGraceEndsAt: true },
    });
    for (const row of graceItems) {
      expect(row.billingGraceEndsAt?.getTime()).toBeGreaterThanOrEqual(
        before + 30 * 86_400_000,
      );
    }
    expect(plaidMock.itemRemove).toHaveLength(0);
  });

  it("disconnects after grace expires and deletes transactions imported during grace", async () => {
    const u = await userWithTrial("expired-grace@example.com", null);
    const ws = await workspaceForOwner(u.id);
    const row = await item({
      workspaceId: ws.id,
      connectedBy: u.id,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      itemId: "expired_grace",
    });
    await prisma.plaidItem.update({
      where: { id: row.id },
      data: { billingGraceEndsAt: new Date(Date.now() - 1_000) },
    });
    const account = await prisma.bankAccount.findFirstOrThrow({
      where: { plaidItemId: row.id },
    });
    const hidden = await prisma.transaction.create({
      data: {
        workspaceId: ws.id,
        accountId: account.id,
        plaidItemId: row.id,
        plaidTransactionId: "expired_grace_tx",
        amount: "10",
        merchantRaw: "Hidden grace transaction",
        occurredAt: new Date(),
        source: "plaid",
        rawData: {},
        removedAt: new Date(),
        billingGraceHiddenAt: new Date(),
      },
    });
    plaidMock.itemRemove.push({ data: { request_id: "remove-expired-grace" } });

    const result = await reconcilePlaidItemsForUser(env, u.id);

    expect(result.disconnected).toEqual([row.id]);
    await expect(prisma.plaidItem.findUnique({ where: { id: row.id } })).resolves.toBeNull();
    await expect(prisma.transaction.findUnique({ where: { id: hidden.id } })).resolves.toBeNull();
    await expect(
      prisma.bankAccount.findUniqueOrThrow({ where: { id: account.id } }),
    ).resolves.toMatchObject({
      archivedAt: expect.any(Date),
      plaidReconnectRequired: true,
    });
  });

  it("upgrade during grace restores hidden transactions without reconnecting", async () => {
    const u = await userWithTrial("grace-upgrade@example.com", null);
    const ws = await workspaceForOwner(u.id);
    const row = await item({
      workspaceId: ws.id,
      connectedBy: u.id,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      itemId: "grace_upgrade",
    });
    await prisma.plaidItem.update({
      where: { id: row.id },
      data: { billingGraceEndsAt: new Date(Date.now() + 10 * 86_400_000) },
    });
    const account = await prisma.bankAccount.findFirstOrThrow({ where: { plaidItemId: row.id } });
    const hiddenAt = new Date();
    const hidden = await prisma.transaction.create({
      data: {
        workspaceId: ws.id,
        accountId: account.id,
        plaidItemId: row.id,
        plaidTransactionId: "grace_upgrade_tx",
        amount: "12",
        merchantRaw: "Grace upgrade",
        occurredAt: new Date(),
        source: "plaid",
        rawData: {},
        removedAt: hiddenAt,
        billingGraceHiddenAt: hiddenAt,
      },
    });
    await prisma.subscription.create({
      data: {
        userId: u.id,
        tier: "pro",
        source: "stripe",
        sourceSubscriptionId: "sub_grace_upgrade",
        status: "active",
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
    });

    const result = await reconcilePlaidItemsForUser(env, u.id);

    expect(result.kept).toEqual([row.id]);
    await expect(prisma.plaidItem.findUniqueOrThrow({ where: { id: row.id } })).resolves
      .toMatchObject({ billingGraceEndsAt: null });
    await expect(prisma.transaction.findUniqueOrThrow({ where: { id: hidden.id } })).resolves
      .toMatchObject({ removedAt: null, billingGraceHiddenAt: null });
  });

  it("counts active, error, and relink_required as billable but ignores disconnected", async () => {
    const u = await userWithTrial("status@example.com", null);
    await prisma.subscription.create({
      data: {
        userId: u.id,
        tier: "pro",
        source: "stripe",
        sourceSubscriptionId: "sub_status",
        status: "active",
        currentPeriodEnd: new Date("2026-07-01T00:00:00Z"),
      },
    });
    const ws = await workspaceForOwner(u.id);
    const active = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "status_active" });
    const error = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-02T00:00:00Z"), itemId: "status_error" });
    const relink = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-03T00:00:00Z"), itemId: "status_relink" });
    const disconnected = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-04T00:00:00Z"), itemId: "status_disconnected" });
    await prisma.plaidItem.update({ where: { id: error.id }, data: { status: "error" } });
    await prisma.plaidItem.update({ where: { id: relink.id }, data: { status: "relink_required" } });
    await prisma.plaidItem.update({ where: { id: disconnected.id }, data: { status: "disconnected" } });

    const result = await reconcilePlaidItemsForUser(env, u.id);

    expect(result.kept.sort()).toEqual([active.id, error.id, relink.id].sort());
    expect(result.disconnected).toEqual([]);
  });
});

describe("reconcileOrphanPlaidItems", () => {
  it("disconnects null-owner items even when the workspace has exactly one owner", async () => {
    const u = await userWithTrial("owner2@example.com", null);
    const ws = await workspaceForOwner(u.id);
    const legacy = await item({ workspaceId: ws.id, connectedBy: null, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "legacy" });
    plaidMock.itemRemove.push({ data: { request_id: "remove-legacy" } });

    const result = await reconcileOrphanPlaidItems(env);

    expect(result.kept).toEqual([]);
    expect(result.disconnected).toEqual([legacy.id]);
    await expect(
      prisma.plaidItem.findUnique({ where: { id: legacy.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.bankAccount.findFirstOrThrow({ where: { workspaceId: ws.id } }),
    ).resolves.toMatchObject({ plaidReconnectRequired: false });
  });

  it("disconnects null-owner items without an owner", async () => {
    const u = await userWithTrial("owner3@example.com", null);
    const ws = await workspaceForOwner(u.id);
    await prisma.membership.deleteMany({ where: { workspaceId: ws.id } });
    const ambiguous = await item({ workspaceId: ws.id, connectedBy: null, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "ambiguous" });
    plaidMock.itemRemove.push({ data: { request_id: "remove-ambiguous" } });

    const result = await reconcileOrphanPlaidItems(env);

    expect(result.disconnected).toEqual([ambiguous.id]);
    await expect(
      prisma.plaidItem.findUnique({ where: { id: ambiguous.id } }),
    ).resolves.toBeNull();
  });
});

describe("retryPendingPlaidBillingCleanups", () => {
  it("retries disconnected items marked billing_cleanup_pending", async () => {
    const u = await userWithTrial("pending@example.com", null);
    const ws = await workspaceForOwner(u.id);
    const pending = await item({ workspaceId: ws.id, connectedBy: u.id, createdAt: new Date("2026-01-01T00:00:00Z"), itemId: "pending" });
    await prisma.plaidItem.update({
      where: { id: pending.id },
      data: { status: "disconnected", errorCode: "billing_cleanup_pending" },
    });
    plaidMock.itemRemove.push({ data: { request_id: "remove-pending" } });

    const result = await retryPendingPlaidBillingCleanups(env);

    expect(result.disconnected).toEqual([pending.id]);
    await expect(
      prisma.plaidItem.findUnique({ where: { id: pending.id } }),
    ).resolves.toBeNull();
    const accountAfter = await prisma.bankAccount.findFirstOrThrow({
      where: { workspaceId: ws.id },
    });
    expect(accountAfter.plaidItemId).toBeNull();
    expect(accountAfter.archivedAt).not.toBeNull();
  });
});
