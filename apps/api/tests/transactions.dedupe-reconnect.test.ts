import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../src/db.js";
import {
  dedupeReconnectTransactionsByEmail,
  findReconnectDuplicateCandidatesByEmail,
} from "../src/transactions/dedupe-reconnect.js";
import { disconnect, truncateAll } from "./helpers/db.js";

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await disconnect();
});

describe("reconnect duplicate transaction cleanup", () => {
  it("dry-runs first, then preserves user metadata while hiding the historical duplicate", async () => {
    const email = "reconnect-cleanup@example.com";
    const user = await prisma.user.create({
      data: { id: randomUUID(), email, name: "Reconnect User", emailVerified: true },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Reconnect workspace",
        memberships: { create: { userId: user.id, role: "owner" } },
      },
    });
    const category = await prisma.category.create({
      data: {
        workspaceId: workspace.id,
        name: "Coffee",
        type: "expense",
      },
    });
    const archivedAt = new Date("2026-07-01T00:00:00.000Z");
    const historicalAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: workspace.id,
        plaidInstitutionId: "ins_reconnect",
        plaidAccountId: "old_account",
        name: "Old checking",
        mask: "1234",
        type: "depository",
        subtype: "checking",
        currency: "CAD",
        archivedAt,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const currentItem = await prisma.plaidItem.create({
      data: {
        workspaceId: workspace.id,
        connectedBy: user.id,
        itemId: "new_item",
        institutionId: "ins_reconnect",
        institutionName: "Reconnect Bank",
        accessTokenCiphertext: Buffer.from("unused"),
        accessTokenIv: Buffer.from("unused"),
      },
    });
    const currentAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: workspace.id,
        plaidItemId: currentItem.id,
        plaidInstitutionId: "ins_reconnect",
        plaidAccountId: "new_account",
        name: "Current checking",
        mask: "1234",
        type: "depository",
        subtype: "cash management",
        currency: "CAD",
        createdAt: new Date("2026-07-02T00:00:00.000Z"),
      },
    });
    const historical = await prisma.transaction.create({
      data: {
        workspaceId: workspace.id,
        accountId: historicalAccount.id,
        plaidTransactionId: "old_transaction_id",
        amount: "6.50",
        merchantRaw: "Coffee Shop 123",
        merchantNormalized: "coffee shop",
        occurredAt: new Date("2026-06-27T12:00:00.000Z"),
        postedAt: new Date("2026-06-29T12:00:00.000Z"),
        source: "plaid",
        rawData: {},
        note: "Keep this note",
        budgetImpact: "excluded",
        budgetImpactSource: "user",
        createdAt: new Date("2026-06-29T13:00:00.000Z"),
        allocations: {
          create: {
            categoryId: category.id,
            amount: "6.50",
            source: "manual",
          },
        },
      },
    });
    const current = await prisma.transaction.create({
      data: {
        workspaceId: workspace.id,
        accountId: currentAccount.id,
        plaidItemId: currentItem.id,
        plaidTransactionId: "new_transaction_id",
        amount: "6.50",
        merchantRaw: "Coffee Shop Vancouver",
        merchantNormalized: "coffee shop",
        occurredAt: new Date("2026-06-28T12:00:00.000Z"),
        postedAt: new Date("2026-06-29T12:00:00.000Z"),
        source: "plaid",
        rawData: {},
        createdAt: new Date("2026-07-02T01:00:00.000Z"),
        allocations: {
          create: {
            categoryId: null,
            amount: "6.50",
            source: null,
          },
        },
      },
    });
    const schedule = await prisma.scheduledSpend.create({
      data: {
        workspaceId: workspace.id,
        categoryId: category.id,
        amount: "6.50",
        scheduledDate: new Date("2026-06-29T00:00:00.000Z"),
        matchedTxId: historical.id,
      },
    });

    const found = await findReconnectDuplicateCandidatesByEmail(email);

    expect(found.candidates).toHaveLength(1);
    expect(found.candidates[0]).toMatchObject({
      historicalTransactionId: historical.id,
      currentTransactionId: current.id,
      matchBasis: "posted_date",
      dateDeltaDays: 0,
      subtypeChanged: true,
    });

    const dryRun = await dedupeReconnectTransactionsByEmail(email);
    expect(dryRun).toMatchObject({ softRemoved: 0, skipped: 0 });
    await expect(
      prisma.transaction.findUniqueOrThrow({ where: { id: historical.id } }),
    ).resolves.toMatchObject({ removedAt: null });

    const applied = await dedupeReconnectTransactionsByEmail(email, { apply: true });

    expect(applied).toMatchObject({ softRemoved: 1, skipped: 0 });
    await expect(
      prisma.transaction.findUniqueOrThrow({ where: { id: historical.id } }),
    ).resolves.toMatchObject({ removedAt: expect.any(Date) });
    const kept = await prisma.transaction.findUniqueOrThrow({
      where: { id: current.id },
      include: { allocations: true },
    });
    expect(kept).toMatchObject({
      note: "Keep this note",
      budgetImpact: "excluded",
      budgetImpactSource: "user",
    });
    expect(kept.allocations).toHaveLength(1);
    expect(kept.allocations[0]).toMatchObject({
      categoryId: category.id,
      source: "manual",
    });
    await expect(
      prisma.scheduledSpend.findUniqueOrThrow({ where: { id: schedule.id } }),
    ).resolves.toMatchObject({ matchedTxId: current.id });
  });

  it("does not match different account masks or merchants", async () => {
    const email = "reconnect-no-false-positive@example.com";
    const user = await prisma.user.create({
      data: { id: randomUUID(), email, name: "No false positive" },
    });
    const workspace = await prisma.workspace.create({
      data: {
        name: "Safe workspace",
        memberships: { create: { userId: user.id, role: "owner" } },
      },
    });
    const oldAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: workspace.id,
        plaidInstitutionId: "ins_same",
        plaidAccountId: "old_other",
        name: "Old",
        mask: "1111",
        type: "depository",
        currency: "CAD",
        archivedAt: new Date("2026-07-01T00:00:00.000Z"),
      },
    });
    const item = await prisma.plaidItem.create({
      data: {
        workspaceId: workspace.id,
        itemId: "new_other_item",
        institutionId: "ins_same",
        institutionName: "Bank",
        accessTokenCiphertext: Buffer.from("unused"),
        accessTokenIv: Buffer.from("unused"),
      },
    });
    const currentAccount = await prisma.bankAccount.create({
      data: {
        workspaceId: workspace.id,
        plaidItemId: item.id,
        plaidInstitutionId: "ins_same",
        plaidAccountId: "new_other",
        name: "New",
        mask: "2222",
        type: "depository",
        currency: "CAD",
        createdAt: new Date("2026-07-02T00:00:00.000Z"),
      },
    });
    for (const [accountId, plaidTransactionId, merchantRaw, createdAt] of [
      [oldAccount.id, "old_other_tx", "Coffee", new Date("2026-06-30T00:00:00Z")],
      [currentAccount.id, "new_other_tx", "Tea", new Date("2026-07-02T01:00:00Z")],
    ] as const) {
      await prisma.transaction.create({
        data: {
          workspaceId: workspace.id,
          accountId,
          plaidItemId: accountId === currentAccount.id ? item.id : null,
          plaidTransactionId,
          amount: "5.00",
          merchantRaw,
          occurredAt: new Date("2026-06-29T12:00:00Z"),
          source: "plaid",
          rawData: {},
          createdAt,
        },
      });
    }

    const found = await findReconnectDuplicateCandidatesByEmail(email);
    expect(found.candidates).toEqual([]);
  });
});
