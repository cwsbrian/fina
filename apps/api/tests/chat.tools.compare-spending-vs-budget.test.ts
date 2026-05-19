import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { setBudget } from "../src/chat/tools/set-budget.js";
import { compareSpendingVsBudget } from "../src/chat/tools/compare-spending-vs-budget.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("compareSpendingVsBudget chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let coffeeCatId: string;

  beforeEach(async () => {
    const stamp = `cmp-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "CMP", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "cmp-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    coffeeCatId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns service output unchanged for this_month", async () => {
    await setBudget.run(ctx, { category_id: coffeeCatId, amount: 100 });
    const acct = await prisma.bankAccount.create({ data: { workspaceId: wsId, name: "x", type: "depository" } });
    await prisma.transaction.create({
      data: {
        workspaceId: wsId, accountId: acct.id, plaidTransactionId: "t1",
        amount: "30.00", merchantRaw: "M", categoryId: coffeeCatId,
        occurredAt: new Date("2026-05-10T12:00:00Z"), rawData: {},
      },
    });
    const r = await compareSpendingVsBudget.run(ctx, { period: "this_month" });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.spent).toBe("30.00");
  });
});
