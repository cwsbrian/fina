import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { listRecurring } from "../src/chat/tools/list-recurring.js";
import { addRecurring } from "../src/chat/tools/add-recurring.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listRecurring chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let streamingCatId: string;

  beforeEach(async () => {
    const stamp = `lrch-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "LRCH", tz: "America/Toronto" },
    });
    const ws = await prisma.workspace.create({ data: { name: "lrch-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    streamingCatId = (await prisma.category.create({ data: { workspaceId: wsId, name: "Streaming" } })).id;
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns empty array when no rows", async () => {
    const out = await listRecurring.run(ctx, {});
    expect(out.recurring).toEqual([]);
  });

  it("hydrates categoryName for non-null categoryId rows", async () => {
    await addRecurring.run(ctx, {
      name: "Netflix",
      amount: 19.99,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
      category_id: streamingCatId,
    });
    const out = await listRecurring.run(ctx, {});
    expect(out.recurring).toHaveLength(1);
    expect(out.recurring[0]!.categoryName).toBe("Streaming");
  });

  it("returns categoryName=null when categoryId is null", async () => {
    await addRecurring.run(ctx, {
      name: "Hydro",
      amount: 90,
      cadence: "monthly",
      next_occurrence_date: "2026-06-01",
    });
    const out = await listRecurring.run(ctx, {});
    expect(out.recurring[0]!.categoryName).toBeNull();
  });
});
