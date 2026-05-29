import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { updateGoal } from "../src/chat/tools/update-goal.js";
import { archiveGoal } from "../src/chat/tools/archive-goal.js";
import { listGoals } from "../src/chat/tools/list-goals.js";
import type { ToolContext } from "../src/chat/tools/types.js";

describe("updateGoal + archiveGoal chat tools", () => {
  let wsId: string;
  let proCtx: ToolContext;
  let freeCtx: ToolContext;

  async function seedGoal(): Promise<string> {
    const g = await prisma.goal.create({
      data: {
        workspaceId: wsId, title: "Japan trip",
        targetAmount: new Prisma.Decimal(2000), savedAmount: new Prisma.Decimal(0),
        dueDate: new Date(Date.now() + 60 * 86_400_000),
      },
    });
    return g.id;
  }

  beforeEach(async () => {
    const stamp = `ua-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: "ua-ws", currency: "CAD" } });
    wsId = ws.id;
    const pro = await prisma.user.create({
      data: { id: `${stamp}-pro`, email: `${stamp}-pro@t.co`, name: "Pro", tz: "America/Toronto", trialEndsAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    await prisma.membership.create({ data: { userId: pro.id, workspaceId: wsId, role: "owner" } });
    proCtx = { env: {} as never, workspaceId: wsId, userId: pro.id, role: "owner" };
    const free = await prisma.user.create({
      data: { id: `${stamp}-free`, email: `${stamp}-free@t.co`, name: "Free", tz: "America/Toronto", trialEndsAt: new Date(Date.now() - 86_400_000), trialConsumed: true },
    });
    await prisma.membership.create({ data: { userId: free.id, workspaceId: wsId, role: "editor" } });
    freeCtx = { env: {} as never, workspaceId: wsId, userId: free.id, role: "editor" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("updateGoal patches the target amount", async () => {
    const id = await seedGoal();
    const r = await updateGoal.run(proCtx, { goal_id: id, target_amount: 3000 });
    expect(r.goal.targetAmount).toBe("3000.00");
  });

  it("updateGoal rejects a non-Pro user", async () => {
    const id = await seedGoal();
    await expect(updateGoal.run(freeCtx, { goal_id: id, target_amount: 3000 })).rejects.toMatchObject({ code: "upgrade_required" });
  });

  it("updateGoal throws goal_not_found for an unknown id", async () => {
    await expect(updateGoal.run(proCtx, { goal_id: "nope", target_amount: 3000 })).rejects.toThrow("goal_not_found");
  });

  it("archiveGoal archives the goal and removes it from listGoals", async () => {
    const id = await seedGoal();
    const r = await archiveGoal.run(proCtx, { goal_id: id });
    expect(r.goal.archivedAt).not.toBeNull();
    const list = await listGoals.run(proCtx, {});
    expect(list.block).toBeUndefined();
  });

  it("archiveGoal rejects a non-Pro user", async () => {
    const id = await seedGoal();
    await expect(archiveGoal.run(freeCtx, { goal_id: id })).rejects.toMatchObject({ code: "upgrade_required" });
  });
});
