import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { setBudget } from "../src/chat/tools/set-budget.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("setBudget chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let coffeeCatId: string;

  beforeEach(async () => {
    const stamp = `sb-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "SB", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "sb-ws" } });
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

  it("Zod rejects amount: 0", () => {
    const r = setBudget.args.safeParse({ category_id: coffeeCatId, amount: 0, period: "this_month" });
    expect(r.success).toBe(false);
  });

  it("Zod rejects both category_id and category_name set", () => {
    const r = setBudget.args.safeParse({
      category_id: coffeeCatId,
      category_name: "Coffee",
      amount: 500,
    });
    expect(r.success).toBe(false);
  });

  it("Zod accepts amount with just category_id", () => {
    const r = setBudget.args.safeParse({ category_id: coffeeCatId, amount: 500 });
    expect(r.success).toBe(true);
  });

  it("resolves category by name case-insensitively + returns canonical name", async () => {
    const out = await setBudget.run(ctx, { category_name: "coffee", amount: 500 });
    expect(out.budget.categoryId).toBe(coffeeCatId);
    expect(out.budget.categoryName).toBe("Coffee");
  });

  it("upserts on conflict", async () => {
    await setBudget.run(ctx, { category_id: coffeeCatId, amount: 500 });
    const out = await setBudget.run(ctx, { category_id: coffeeCatId, amount: 700 });
    expect(out.budget.amount).toBe("700.00");
    expect(await prisma.budget.count({ where: { workspaceId: wsId } })).toBe(1);
  });
});
