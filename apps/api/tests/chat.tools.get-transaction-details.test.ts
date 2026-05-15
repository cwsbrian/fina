import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { getTransactionDetails } from "../src/chat/tools/get-transaction-details.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getTransactionDetails tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let txId: string;
  let softDeletedTxId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `gt-${Date.now()}`, email: `gt-${Date.now()}@t.co`, name: "GT" } });
    const ws = await prisma.workspace.create({ data: { name: "gt-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };

    const parent = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    const child = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee", parentId: parent.id } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "Chequing", type: "depository" } });
    const tx = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct.id,
        plaidTransactionId: `t-${Date.now()}`,
        amount: "5.00",
        merchantRaw: "Starbucks 1234",
        merchantNormalized: "starbucks",
        categoryId: child.id,
        occurredAt: new Date("2026-05-01T12:00:00Z"),
        rawData: {},
        categorizationSource: "manual",
      },
    });
    txId = tx.id;

    const tx2 = await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct.id,
        plaidTransactionId: `t-${Date.now()}-d`,
        amount: "9.00",
        merchantRaw: "Gone",
        occurredAt: new Date("2026-05-02T12:00:00Z"),
        rawData: {},
        removedAt: new Date(),
      },
    });
    softDeletedTxId = tx2.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns full transaction with account and parent category", async () => {
    const res = await getTransactionDetails.run(ctx, { tx_id: txId });
    expect(res.transaction.merchantRaw).toBe("Starbucks 1234");
    expect(res.transaction.amount).toBe("5");
    expect(res.transaction.account.name).toBe("Chequing");
    expect(res.transaction.category?.name).toBe("Coffee");
    expect(res.transaction.category?.parentName).toBe("Food");
  });

  it("throws transaction_not_found for unknown id", async () => {
    await expect(getTransactionDetails.run(ctx, { tx_id: "does-not-exist" })).rejects.toThrow("transaction_not_found");
  });

  it("throws transaction_not_found for cross-workspace id", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const oa = await prisma.bankAccount.create({ data: { workspaceId: other.id, name: "x", type: "depository" } });
    const otherTx = await prisma.transaction.create({
      data: {
        workspaceId: other.id,
        accountId: oa.id,
        plaidTransactionId: `x-${Date.now()}`,
        amount: "1.00",
        merchantRaw: "x",
        occurredAt: new Date(),
        rawData: {},
      },
    });
    await expect(getTransactionDetails.run(ctx, { tx_id: otherTx.id })).rejects.toThrow("transaction_not_found");
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("returns soft-deleted transaction with removedAt", async () => {
    const res = await getTransactionDetails.run(ctx, { tx_id: softDeletedTxId });
    expect(res.transaction.removedAt).not.toBeNull();
    expect(res.transaction.merchantRaw).toBe("Gone");
  });
});
