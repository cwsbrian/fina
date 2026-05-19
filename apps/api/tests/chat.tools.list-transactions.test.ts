import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { listTransactions } from "../src/chat/tools/list-transactions.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listTransactions tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let acctId: string;

  beforeEach(async () => {
    const stamp = `lt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "LT" } });
    const ws = await prisma.workspace.create({ data: { name: "lt-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    acctId = acct.id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function seedTx(occurredAt: Date, amount: string): Promise<string> {
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acctId, plaidTransactionId: `t-${Math.random()}`, amount, merchantRaw: "M", occurredAt, rawData: {} },
    });
    return tx.id;
  }

  async function seedSplitTx(
    occurredAt: Date,
    amount: string,
    allocs: Array<{ categoryId: string | null; amount: string }>,
  ): Promise<string> {
    const tx = await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acctId, plaidTransactionId: `t-split-${Math.random()}`, amount, merchantRaw: "M-split", occurredAt, rawData: {} },
    });
    // Replace the auto-backfilled allocation with explicit split allocations
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: tx.id } });
    await prisma.transactionAllocation.createMany({
      data: allocs.map((a) => ({
        transactionId: tx.id,
        categoryId: a.categoryId,
        amount: a.amount,
        source: "manual" as const,
      })),
    });
    return tx.id;
  }

  it("returns last 20 by default, newest first", async () => {
    for (let i = 0; i < 30; i++) await seedTx(new Date(2026, 4, i + 1), `${i}.00`);
    const result = await listTransactions.run(ctx, {});
    expect(result.transactions).toHaveLength(20);
    expect(new Date(result.transactions[0].occurredAt).getTime()).toBeGreaterThan(new Date(result.transactions[1].occurredAt).getTime());
  });

  it("respects limit", async () => {
    for (let i = 0; i < 10; i++) await seedTx(new Date(2026, 4, i + 1), "1.00");
    const result = await listTransactions.run(ctx, { limit: 5 });
    expect(result.transactions).toHaveLength(5);
  });

  it("filters by period=this_month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    try {
      // Pinned to mid-May. Toronto user → this_month = May 2026.
      // Explicit UTC instants safely inside Toronto's May vs. April.
      const thisMonth = new Date("2026-05-05T12:00:00Z");
      const lastMonth = new Date("2026-04-05T12:00:00Z");
      await seedTx(thisMonth, "10.00");
      await seedTx(lastMonth, "20.00");
      const result = await listTransactions.run(ctx, { period: "this_month" });
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]!.occurredAt).toBe("2026-05-05T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps limit at 50", async () => {
    const parsed = listTransactions.args.safeParse({ limit: 100 });
    expect(parsed.success).toBe(false);
  });

  it("result includes allocations array and needsReclassification per tx", async () => {
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Cat-lt-alloc" } });
    const txId = await seedTx(new Date("2026-05-01T12:00:00Z"), "15.00");
    // Replace auto-backfilled allocation with a categorized one
    await prisma.transactionAllocation.deleteMany({ where: { transactionId: txId } });
    await prisma.transactionAllocation.createMany({
      data: [{ transactionId: txId, categoryId: cat.id, amount: "15.00", source: "manual" }],
    });
    const result = await listTransactions.run(ctx, { limit: 1 });
    expect(result.transactions).toHaveLength(1);
    const t = result.transactions[0]!;
    expect(t.allocations).toHaveLength(1);
    expect(t.allocations[0]!.categoryId).toBe(cat.id);
    expect(t.allocations[0]!.amount).toBe("15");
    expect(t.allocations[0]!.source).toBe("manual");
    expect(t.needsReclassification).toBe(false);
  });

  it("split tx (N=2) returns both allocations", async () => {
    const c1 = await prisma.category.create({ data: { workspaceId: wsId, name: "C1-lt-split" } });
    const c2 = await prisma.category.create({ data: { workspaceId: wsId, name: "C2-lt-split" } });
    await seedSplitTx(new Date("2026-05-02T12:00:00Z"), "100.00", [
      { categoryId: c1.id, amount: "60.00" },
      { categoryId: c2.id, amount: "40.00" },
    ]);
    const result = await listTransactions.run(ctx, { limit: 1 });
    const t = result.transactions[0]!;
    expect(t.allocations).toHaveLength(2);
    const catIds = t.allocations.map((a) => a.categoryId);
    expect(catIds).toContain(c1.id);
    expect(catIds).toContain(c2.id);
  });

  it("isolates by workspace", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    const otherAcct = await prisma.bankAccount.create({ data: { workspaceId: other.id, name: "x", type: "depository" } });
    await prisma.transaction.create({ data: { workspaceId: other.id, accountId: otherAcct.id, plaidTransactionId: "x", amount: "9.99", merchantRaw: "x", occurredAt: new Date(), rawData: {} } });
    const result = await listTransactions.run(ctx, {});
    expect(result.transactions).toHaveLength(0);
    await prisma.workspace.delete({ where: { id: other.id } });
  });
});
