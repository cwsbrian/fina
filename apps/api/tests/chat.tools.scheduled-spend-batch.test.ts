import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { addScheduledSpendBatchService } from "../src/schedules/service.js";
import { addScheduledSpendBatch } from "../src/chat/tools/add-scheduled-spend-batch.js";
import type { ToolContext } from "../src/chat/tools/types.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string) {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  // Use unique names to avoid collision with the bootstrapped default categories
  const groceries = await prisma.category.create({ data: { workspaceId: wsId, name: "BatchTest-Groceries" } });
  const dining = await prisma.category.create({ data: { workspaceId: wsId, name: "BatchTest-Dining" } });
  return { wsId, userId: u.userId, groceries: groceries.id, dining: dining.id };
}

describe("addScheduledSpendBatchService", () => {
  it("inserts all items and returns them", async () => {
    const { wsId, groceries, dining } = await setup("batch-all@t.co");
    const result = await addScheduledSpendBatchService({
      workspaceId: wsId,
      items: [
        { categoryId: groceries, amount: 60, scheduledDate: "2026-06-03" },
        { categoryId: dining, amount: 45, scheduledDate: "2026-06-10", note: "dinner" },
      ],
    });
    expect(result.count).toBe(2);
    expect(result.schedules).toHaveLength(2);
    const amounts = result.schedules.map((s) => s.amount).sort();
    expect(amounts).toEqual(["45", "60"]);
    // Confirm rows were persisted
    const rows = await prisma.scheduledSpend.findMany({ where: { workspaceId: wsId } });
    expect(rows).toHaveLength(2);
  });

  it("all-or-nothing: one bad categoryId → zero rows written", async () => {
    const { wsId, groceries } = await setup("batch-rollback@t.co");
    await expect(
      addScheduledSpendBatchService({
        workspaceId: wsId,
        items: [
          { categoryId: groceries, amount: 60, scheduledDate: "2026-06-03" },
          { categoryId: "non-existent-category-id", amount: 40, scheduledDate: "2026-06-10" },
        ],
      }),
    ).rejects.toThrow();
    // Atomicity: first insert must have rolled back too
    const rows = await prisma.scheduledSpend.findMany({ where: { workspaceId: wsId } });
    expect(rows).toHaveLength(0);
  });

  it("invalid amount (-5) rejected before any write", async () => {
    const { wsId, groceries } = await setup("batch-badamt@t.co");
    await expect(
      addScheduledSpendBatchService({
        workspaceId: wsId,
        items: [
          { categoryId: groceries, amount: -5, scheduledDate: "2026-06-03" },
        ],
      }),
    ).rejects.toThrow();
    // Validation must have thrown before the lock — zero rows
    const rows = await prisma.scheduledSpend.findMany({ where: { workspaceId: wsId } });
    expect(rows).toHaveLength(0);
  });
});

describe("addScheduledSpendBatch tool", () => {
  it("resolves category names (mixed case) and creates all rows", async () => {
    const { wsId, userId } = await setup("tool-batch-ok@t.co");
    // Use bootstrapped default categories (Groceries + Dining seeded at workspace creation)
    const g = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Groceries" } });
    const d = await prisma.category.findFirstOrThrow({ where: { workspaceId: wsId, name: "Dining" } });

    const ctx: ToolContext = { env: {} as never, workspaceId: wsId, userId, role: "owner" };
    const result = await addScheduledSpendBatch.run(ctx, {
      items: [
        // "groceries" (lowercase) resolves to the seeded "Groceries" row
        { category: "groceries", amount: 60, scheduled_date: "2026-06-03" },
        // "Dining" (exact case) resolves to the seeded "Dining" row
        { category: "Dining", amount: 45, scheduled_date: "2026-06-10", note: "dinner" },
      ],
    });
    expect(result.count).toBe(2);
    expect(result.schedules).toHaveLength(2);

    const rows = await prisma.scheduledSpend.findMany({
      where: { workspaceId: wsId, categoryId: { in: [g.id, d.id] } },
    });
    expect(rows).toHaveLength(2);
  });

  it("unknown category name 'Nope' throws and writes zero rows", async () => {
    const { wsId, userId } = await setup("tool-batch-unknown@t.co");

    const ctx: ToolContext = { env: {} as never, workspaceId: wsId, userId, role: "owner" };
    await expect(
      addScheduledSpendBatch.run(ctx, {
        items: [
          { category: "Nope", amount: 60, scheduled_date: "2026-06-03" },
        ],
      }),
    ).rejects.toThrow();

    const rows = await prisma.scheduledSpend.findMany({ where: { workspaceId: wsId } });
    expect(rows).toHaveLength(0);
  });
});
