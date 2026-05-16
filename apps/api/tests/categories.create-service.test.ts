import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createCategoryService } from "../src/categories/create.js";

describe("createCategoryService", () => {
  let wsId: string;
  let otherWsId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `cc-${Date.now()}`, email: `cc-${Date.now()}@t.co`, name: "CC" } });
    const ws = await prisma.workspace.create({ data: { name: "cc-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    const ws2 = await prisma.workspace.create({ data: { name: "other-cc-ws" } });
    otherWsId = ws2.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: [wsId, otherWsId] } } });
  });

  it("creates a top-level category", async () => {
    const r = await createCategoryService({ workspaceId: wsId, name: "Food" });
    expect(r.id).toMatch(/^[a-z0-9]+$/);
    expect(r.name).toBe("Food");
    expect(r.parentId).toBeNull();
  });

  it("creates a child with a parent id", async () => {
    const parent = await createCategoryService({ workspaceId: wsId, name: "Food" });
    const child = await createCategoryService({ workspaceId: wsId, name: "Coffee", parentId: parent.id });
    expect(child.parentId).toBe(parent.id);
  });

  it("throws category_exists for duplicate active name (case-insensitive)", async () => {
    await createCategoryService({ workspaceId: wsId, name: "Food" });
    await expect(createCategoryService({ workspaceId: wsId, name: "food" })).rejects.toThrow("category_exists");
  });

  it("allows reusing the name of an archived sibling", async () => {
    const first = await createCategoryService({ workspaceId: wsId, name: "Food" });
    await prisma.category.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
    const r = await createCategoryService({ workspaceId: wsId, name: "Food" });
    expect(r.id).not.toBe(first.id);
  });

  it("throws too_many_categories at the 30-active cap", async () => {
    for (let i = 0; i < 30; i++) {
      await createCategoryService({ workspaceId: wsId, name: `Cat${i}` });
    }
    await expect(createCategoryService({ workspaceId: wsId, name: "Overflow" })).rejects.toThrow("too_many_categories");
  });

  it("isolates by workspace (same name OK across workspaces)", async () => {
    await createCategoryService({ workspaceId: wsId, name: "Food" });
    const r = await createCategoryService({ workspaceId: otherWsId, name: "Food" });
    expect(r.id).toMatch(/^[a-z0-9]+$/);
  });

  it("rejects parentId from another workspace → throws parent_not_found", async () => {
    const otherParent = await createCategoryService({ workspaceId: otherWsId, name: "OtherParent" });
    await expect(
      createCategoryService({ workspaceId: wsId, name: "Child", parentId: otherParent.id }),
    ).rejects.toThrow("parent_not_found");
  });

  it("rejects archived parentId → throws parent_not_found", async () => {
    const parent = await createCategoryService({ workspaceId: wsId, name: "ArchivedParent" });
    await prisma.category.update({ where: { id: parent.id }, data: { archivedAt: new Date() } });
    await expect(
      createCategoryService({ workspaceId: wsId, name: "Child", parentId: parent.id }),
    ).rejects.toThrow("parent_not_found");
  });
});
