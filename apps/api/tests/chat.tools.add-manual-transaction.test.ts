import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { addManualTransaction } from "../src/chat/tools/add-manual-transaction.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("addManualTransaction chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `amt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const user = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "AMT", tz: "America/Vancouver" },
    });
    const workspace = await prisma.workspace.create({
      data: { name: "amt-ws", currency: "CAD" },
    });
    wsId = workspace.id;
    await prisma.membership.create({
      data: { userId: user.id, workspaceId: wsId, role: "editor" },
    });
    ctx = {
      env: {} as never,
      workspaceId: wsId,
      userId: user.id,
      role: "editor",
    };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
    await prisma.user.deleteMany({ where: { id: ctx.userId } });
  });

  it("creates a one-time expense and returns its detail card without a bank", async () => {
    const category = await prisma.category.create({
      data: { workspaceId: wsId, name: "Dining", type: "expense" },
    });

    const result = await addManualTransaction.run(ctx, {
      merchant: "Coffee and a bagel",
      amount: 8.5,
      occurred_at: "2026-07-13",
      category_name: "dining",
    });

    expect(result.transaction).toMatchObject({
      merchantRaw: "Coffee and a bagel",
      amount: "8.5",
      currency: "CAD",
    });
    expect(result.block).toMatchObject({
      type: "transaction_detail",
      merchant: "Coffee and a bagel",
      amount: "8.50",
      source: "manual",
      category: { name: "Dining" },
    });
    const saved = await prisma.transaction.findUniqueOrThrow({
      where: { id: result.transaction.id },
      include: { account: true, allocations: true },
    });
    expect(saved.account.name).toBe("Cash");
    expect(saved.allocations[0]?.categoryId).toBe(category.id);
    expect(result.needsCategory).toBe(false);
  });

  it("auto-categorizes from learned merchant mappings", async () => {
    const category = await prisma.category.create({
      data: { workspaceId: wsId, name: "Dining", type: "expense" },
    });
    await prisma.merchantMapping.create({
      data: {
        workspaceId: wsId,
        merchantNormalized: "coffee and a bagel",
        categoryId: category.id,
        source: "manual",
      },
    });

    const result = await addManualTransaction.run(ctx, {
      merchant: "Coffee and a bagel",
      amount: 8.5,
    });

    expect(result.transaction.category?.name).toBe("Dining");
    expect(result.transaction.allocations[0]?.source).toBe("mapping");
    expect(result.needsCategory).toBe(false);
  });

  it("rejects a different explicit currency until the user confirms a workspace change", async () => {
    await expect(
      addManualTransaction.run(ctx, {
        merchant: "Antonino",
        amount: 4.5,
        currency: "EUR",
        occurred_at: "2026-07-23",
      }),
    ).rejects.toMatchObject({ code: "currency_mismatch" });
    expect(await prisma.transaction.count({ where: { workspaceId: wsId } })).toBe(0);
  });

  it("asks for a category when automatic categorization has no vocabulary", async () => {
    const result = await addManualTransaction.run(ctx, {
      merchant: "Unknown purchase",
      amount: 5,
    });

    expect(result.transaction.category).toBeNull();
    expect(result.needsCategory).toBe(true);
  });

  it("rejects viewers", async () => {
    await expect(
      addManualTransaction.run({ ...ctx, role: "viewer" }, { merchant: "Coffee", amount: 5 }),
    ).rejects.toThrow("insufficient_role");
  });
});
