import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { getGoalDetails } from "../src/chat/tools/get-goal-details.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("getGoalDetails chat tool", () => {
  let ctx: ToolContext;
  let wsId: string;

  async function seedGoal(title: string, archived = false): Promise<string> {
    const g = await prisma.goal.create({
      data: {
        workspaceId: wsId,
        title,
        targetAmount: new Prisma.Decimal(2000),
        savedAmount: new Prisma.Decimal(0),
        dueDate: new Date("2026-06-26T12:00:00.000Z"),
        ...(archived ? { archivedAt: new Date("2026-05-01T12:00:00.000Z") } : {}),
      },
    });
    return g.id;
  }

  beforeEach(async () => {
    const stamp = `gd-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "GD", tz: "America/Toronto" } });
    const ws = await prisma.workspace.create({ data: { name: "gd-ws", currency: "CAD" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "owner" } });
    ctx = { env: {} as never, workspaceId: wsId, userId: u.id, role: "owner" };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await prisma.goalAllocation.deleteMany({ where: { goal: { workspaceId: wsId } } });
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("returns goal_detail by id", async () => {
    const id = await seedGoal("Japan trip");
    const r = await getGoalDetails.run(ctx, { goal_id: id });
    if (r.block?.type !== "goal_detail") throw new Error("wrong block");
    expect(r.block.id).toBe(id);
    expect(r.block.title).toBe("Japan trip");
    expect(r.block.due_label).toBe("D-42");
    expect(r.block.days_left).toBe(42);
    expect(r.block.note).toBeTruthy();
  });

  it("renders allocations and strategy_note when present", async () => {
    const cat = await prisma.category.create({
      data: { workspaceId: wsId, name: "Dining", icon: "restaurant-outline", color: "#cc3366" },
    });
    const g = await prisma.goal.create({
      data: {
        workspaceId: wsId,
        title: "Japan trip",
        targetAmount: new Prisma.Decimal(2000),
        savedAmount: new Prisma.Decimal(0),
        dueDate: new Date("2026-06-26T12:00:00.000Z"),
        strategy: { generatedAt: "2026-05-10T00:00:00.000Z", notice: "Not enough history yet." },
        allocations: {
          create: [
            { categoryId: cat.id, monthlyAmount: new Prisma.Decimal(150), rationale: "Cut dining out" },
          ],
        },
      },
    });
    const r = await getGoalDetails.run(ctx, { goal_id: g.id });
    if (r.block?.type !== "goal_detail") throw new Error("wrong block");
    expect(r.block.allocations).toHaveLength(1);
    expect(r.block.allocations![0]!.category.name).toBe("Dining");
    expect(r.block.allocations![0]!.monthly).toBe("150.00");
    expect(r.block.allocations![0]!.rationale).toBe("Cut dining out");
    expect(r.block.strategy_note).toBe("Not enough history yet.");
    expect(r.block.currency).toBe("CAD");
  });

  it("resolves a single title match to goal_detail", async () => {
    await seedGoal("Japan trip");
    const r = await getGoalDetails.run(ctx, { title: "japan" });
    if (r.block?.type !== "goal_detail") throw new Error("wrong block");
    expect(r.block.title).toBe("Japan trip");
  });

  it("returns ambiguous (no block) when >1 title matches", async () => {
    await seedGoal("Trip to Japan");
    await seedGoal("Trip to Italy");
    const r = await getGoalDetails.run(ctx, { title: "trip" });
    expect(r.ambiguous).toBe(true);
    expect(r.block).toBeUndefined();
  });

  it("throws goal_not_found when title matches nothing", async () => {
    await seedGoal("Japan trip");
    await expect(getGoalDetails.run(ctx, { title: "house" })).rejects.toThrow("goal_not_found");
  });

  it("does not match archived goals by title", async () => {
    await seedGoal("Japan trip", true);
    await expect(getGoalDetails.run(ctx, { title: "japan" })).rejects.toThrow("goal_not_found");
  });

  it("throws goal_not_found for an unknown id", async () => {
    await expect(getGoalDetails.run(ctx, { goal_id: "nope" })).rejects.toThrow("goal_not_found");
  });
});
