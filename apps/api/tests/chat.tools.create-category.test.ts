import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { createCategory } from "../src/chat/tools/create-category.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("createCategory chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;
  let userId: string;

  beforeEach(async () => {
    const u = await prisma.user.create({ data: { id: `cct-${Date.now()}`, email: `cct-${Date.now()}@t.co`, name: "CCT" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "cct-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId, role: "owner" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("owner creates a top-level category", async () => {
    const r = await createCategory.run(ctx, { name: "Food" });
    expect(r.category.id).toMatch(/^[a-z0-9]+$/);
    expect(r.category.name).toBe("Food");
    expect(r.category.parentId).toBeNull();
    expect(r.category.parentName).toBeNull();
  });

  it("owner creates a child under existing active parent (case-insensitive)", async () => {
    const parent = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    const r = await createCategory.run(ctx, { name: "Coffee", parent_name: "food" });
    expect(r.category.parentId).toBe(parent.id);
    expect(r.category.parentName).toBe("Food"); // canonical, not the user input "food"
  });

  it("parent_name not found in workspace → throws parent_not_found", async () => {
    await expect(createCategory.run(ctx, { name: "Coffee", parent_name: "Nope" })).rejects.toThrow("parent_not_found");
  });

  it("duplicate active name (case-insensitive) → throws category_exists", async () => {
    await createCategory.run(ctx, { name: "Food" });
    await expect(createCategory.run(ctx, { name: "food" })).rejects.toThrow("category_exists");
  });

  it("archived sibling with same name → creates a new active row", async () => {
    const first = await prisma.category.create({ data: { workspaceId: wsId, name: "Food" } });
    await prisma.category.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
    const r = await createCategory.run(ctx, { name: "Food" });
    expect(r.category.id).not.toBe(first.id);
  });

  it("parent_name in another workspace → throws parent_not_found", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    await prisma.category.create({ data: { workspaceId: other.id, name: "Food" } });
    await expect(createCategory.run(ctx, { name: "Coffee", parent_name: "Food" })).rejects.toThrow("parent_not_found");
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("workspace isolation: row is in caller's workspace, not visible elsewhere", async () => {
    const other = await prisma.workspace.create({ data: { name: "other" } });
    await createCategory.run(ctx, { name: "Food" });
    const others = await prisma.category.findMany({ where: { workspaceId: other.id } });
    expect(others).toHaveLength(0);
    await prisma.workspace.delete({ where: { id: other.id } });
  });

  it("editor caller → throws insufficient_role", async () => {
    const editorCtx: ToolContext = { ...ctx, role: "editor" };
    await expect(createCategory.run(editorCtx, { name: "Food" })).rejects.toThrow("insufficient_role");
  });

  it("at the 30-category cap → throws too_many_categories", async () => {
    for (let i = 0; i < 30; i++) {
      await prisma.category.create({ data: { workspaceId: wsId, name: `Cat${i}` } });
    }
    await expect(createCategory.run(ctx, { name: "Overflow" })).rejects.toThrow("too_many_categories");
  });

  it("Zod: whitespace-only name → fails parsing", async () => {
    // run() receives already-parsed args from dispatchTool; the Zod schema
    // is what enforces .trim().min(1). Test the schema directly.
    const parsed = createCategory.args.safeParse({ name: "   " });
    expect(parsed.success).toBe(false);
  });

  it("Zod: name longer than 40 chars (post-trim) → fails parsing", async () => {
    const parsed = createCategory.args.safeParse({ name: "x".repeat(41) });
    expect(parsed.success).toBe(false);
  });
});
