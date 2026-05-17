import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { addRecurring } from "../src/chat/tools/add-recurring.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("addRecurring chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let streamingCatId: string;

  beforeEach(async () => {
    const stamp = `arch-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "ARCH", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "arch-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    streamingCatId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Streaming" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("Zod rejects amount=0", () => {
    const r = addRecurring.args.safeParse({
      name: "Netflix",
      amount: 0,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    expect(r.success).toBe(false);
  });

  it("Zod rejects malformed next_occurrence_date", () => {
    const r = addRecurring.args.safeParse({
      name: "Netflix",
      amount: 10,
      cadence: "monthly",
      next_occurrence_date: "not-a-date",
    });
    expect(r.success).toBe(false);
  });

  it("Zod accepts semimonthly cadence", () => {
    const r = addRecurring.args.safeParse({
      name: "Paycheck Bill",
      amount: 50,
      cadence: "semimonthly",
      next_occurrence_date: "2026-06-15",
    });
    expect(r.success).toBe(true);
  });

  it("resolves category_name case-insensitively and returns canonical categoryName", async () => {
    const out = await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
      category_name: "streaming",
    });
    expect(out.recurring.categoryId).toBe(streamingCatId);
    expect(out.recurring.categoryName).toBe("Streaming");
  });

  it("upserts on conflict: second call with same name (different case) updates the row", async () => {
    await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    const out = await addRecurring.run(ctx, {
      name: "netflix",
      amount: 22.99,
      cadence: "monthly",
      next_occurrence_date: "2026-07-01",
    });
    expect(out.recurring.amount).toBe("22.99");
    expect(await prisma.recurringExpense.count({ where: { workspaceId: wsId } })).toBe(1);
  });
});
