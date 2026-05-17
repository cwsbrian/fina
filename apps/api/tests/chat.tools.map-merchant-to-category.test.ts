import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { mapMerchantToCategory } from "../src/chat/tools/map-merchant-to-category.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("mapMerchantToCategory chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let coffeeCatId: string;

  beforeEach(async () => {
    const stamp = `mmt-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "MMT", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "mmt-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    coffeeCatId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("Zod rejects when both category_id and category_name are present", () => {
    const r = mapMerchantToCategory.args.safeParse({
      merchant: "Starbucks",
      category_id: coffeeCatId,
      category_name: "Coffee",
    });
    expect(r.success).toBe(false);
  });

  it("Zod rejects when neither category_id nor category_name is present", () => {
    const r = mapMerchantToCategory.args.safeParse({ merchant: "Starbucks" });
    expect(r.success).toBe(false);
  });

  it("resolves category_name case-insensitively and returns canonical categoryName", async () => {
    const out = await mapMerchantToCategory.run(ctx, {
      merchant: "Starbucks",
      category_name: "coffee",
    });
    expect(out.mapping.categoryId).toBe(coffeeCatId);
    expect(out.mapping.categoryName).toBe("Coffee");
  });

  it("includes backfilledCount in result", async () => {
    const acct = await prisma.bankAccount.create({
      data: { workspaceId: wsId, name: "x", type: "depository" },
    });
    await prisma.transaction.create({
      data: {
        workspaceId: wsId,
        accountId: acct.id,
        plaidTransactionId: "t1",
        amount: "10.00",
        currency: "CAD",
        merchantRaw: "Starbucks",
        merchantNormalized: "starbucks",
        categoryId: null,
        occurredAt: new Date("2026-05-10T12:00:00Z"),
        rawData: {},
      },
    });
    const out = await mapMerchantToCategory.run(ctx, {
      merchant: "Starbucks",
      category_id: coffeeCatId,
    });
    expect(out.backfilledCount).toBe(1);
  });

  it("mapping.merchantNormalized is server-normalized (raw with store id/location → 'starbucks')", async () => {
    const out = await mapMerchantToCategory.run(ctx, {
      merchant: "STARBUCKS #1234 TORONTO ON",
      category_id: coffeeCatId,
    });
    expect(out.mapping.merchantNormalized).toBe("starbucks");
  });
});
