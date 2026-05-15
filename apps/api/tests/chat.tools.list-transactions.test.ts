import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { listTransactions } from "../src/chat/tools/list-transactions.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listTransactions tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let acctId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `lt-${Date.now()}`, email: `lt-${Date.now()}@t.co`, name: "LT" } });
    const ws = await prisma.workspace.create({ data: { name: "lt-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    acctId = acct.id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  async function seedTx(occurredAt: Date, amount: string): Promise<void> {
    await prisma.transaction.create({
      data: { workspaceId: wsId, accountId: acctId, plaidTransactionId: `t-${Math.random()}`, amount, merchantRaw: "M", occurredAt, rawData: {} },
    });
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
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 5);
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 5);
    await seedTx(thisMonth, "1.00");
    await seedTx(lastMonth, "2.00");
    const result = await listTransactions.run(ctx, { period: "this_month" });
    expect(result.transactions).toHaveLength(1);
  });

  it("clamps limit at 50", async () => {
    const parsed = listTransactions.args.safeParse({ limit: 100 });
    expect(parsed.success).toBe(false);
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
