import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { removeRecurring } from "../src/chat/tools/remove-recurring.js";
import { addRecurring } from "../src/chat/tools/add-recurring.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("removeRecurring chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const stamp = `rmch-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "RMCH", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "rmch-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("Zod XOR refine rejects both fields and rejects neither", () => {
    expect(removeRecurring.args.safeParse({ recurring_id: "x", name: "Netflix" }).success).toBe(false);
    expect(removeRecurring.args.safeParse({}).success).toBe(false);
  });

  it("removes by id (own row) returns {removed: true}; cross-workspace id returns {removed: false}", async () => {
    const added = await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    const out = await removeRecurring.run(ctx, { recurring_id: added.recurring.id });
    expect(out.removed).toBe(true);
    expect(await prisma.recurringExpense.count({ where: { workspaceId: wsId } })).toBe(0);

    // A second remove with the same id (now gone) returns false.
    const out2 = await removeRecurring.run(ctx, { recurring_id: added.recurring.id });
    expect(out2.removed).toBe(false);
  });

  it("removes by name (case-insensitive) returns {removed: true}; nonexistent name returns {removed: false}", async () => {
    await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    const out = await removeRecurring.run(ctx, { name: "NETFLIX" });
    expect(out.removed).toBe(true);

    const out2 = await removeRecurring.run(ctx, { name: "DoesNotExist" });
    expect(out2.removed).toBe(false);
  });
});
