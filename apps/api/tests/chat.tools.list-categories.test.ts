import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { listCategories } from "../src/chat/tools/list-categories.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("listCategories tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `lc-${Date.now()}`, email: `lc-${Date.now()}@t.co`, name: "LC" } });
    const ws = await prisma.workspace.create({ data: { name: "lc-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns active categories sorted by name", async () => {
    await prisma.category.createMany({ data: [{ workspaceId: wsId, name: "Zoo" }, { workspaceId: wsId, name: "Apple" }, { workspaceId: wsId, name: "Mango" }] });
    const res = await listCategories.run(ctx, {});
    expect(res.categories.map((c) => c.name)).toEqual(["Apple", "Mango", "Zoo"]);
  });

  it("excludes archived categories", async () => {
    await prisma.category.create({ data: { workspaceId: wsId, name: "Old", archivedAt: new Date() } });
    await prisma.category.create({ data: { workspaceId: wsId, name: "Active" } });
    const res = await listCategories.run(ctx, {});
    expect(res.categories).toHaveLength(1);
    expect(res.categories[0].name).toBe("Active");
  });

  it("isolates by workspace", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    await prisma.category.create({ data: { workspaceId: other.id, name: "Foreign" } });
    const res = await listCategories.run(ctx, {});
    expect(res.categories).toHaveLength(0);
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("accepts undefined args (zero-arg tool)", async () => {
    const res = await listCategories.run(ctx, {});
    expect(Array.isArray(res.categories)).toBe(true);
  });
});
