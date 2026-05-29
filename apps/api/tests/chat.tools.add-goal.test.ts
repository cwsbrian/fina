import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { addGoal } from "../src/chat/tools/add-goal.js";
import { minDueDateOneMonthUTC } from "@fina/shared";
import type { ToolContext } from "../src/chat/tools/types.js";
import * as strategyMod from "../src/goals/generate-strategy.js";

// Strategy generation is an LLM call — stub it so the test asserts it
// was TRIGGERED (the fix for chat-created goals spinning forever on a
// null strategy) without hitting Gemini.
vi.mock("../src/goals/generate-strategy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goals/generate-strategy.js")>();
  return { ...actual, generateAndStoreGoalStrategy: vi.fn().mockResolvedValue(undefined) };
});

describe("addGoal chat tool", () => {
  let wsId: string;
  let proCtx: ToolContext;
  let freeCtx: ToolContext;

  function isoPlusDays(n: number): string {
    return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  }

  beforeEach(async () => {
    const stamp = `ag-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const ws = await prisma.workspace.create({ data: { name: "ag-ws", currency: "CAD" } });
    wsId = ws.id;
    // Pro: trial active (future trialEndsAt).
    const pro = await prisma.user.create({
      data: { id: `${stamp}-pro`, email: `${stamp}-pro@t.co`, name: "Pro", tz: "America/Toronto", trialEndsAt: new Date(Date.now() + 30 * 86_400_000) },
    });
    await prisma.membership.create({ data: { userId: pro.id, workspaceId: wsId, role: "owner" } });
    proCtx = { env: {} as never, workspaceId: wsId, userId: pro.id, role: "owner" };
    // Free: trial expired, no subscription.
    const free = await prisma.user.create({
      data: { id: `${stamp}-free`, email: `${stamp}-free@t.co`, name: "Free", tz: "America/Toronto", trialEndsAt: new Date(Date.now() - 86_400_000), trialConsumed: true },
    });
    await prisma.membership.create({ data: { userId: free.id, workspaceId: wsId, role: "editor" } });
    freeCtx = { env: {} as never, workspaceId: wsId, userId: free.id, role: "editor" };
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("creates a goal for a Pro user", async () => {
    const r = await addGoal.run(proCtx, {
      title: "Japan trip",
      target_amount: 2000,
      due_date: isoPlusDays(60),
    });
    expect(r.goal.title).toBe("Japan trip");
    expect(r.goal.targetAmount).toBe("2000.00");
    const inDb = await prisma.goal.findFirst({ where: { workspaceId: wsId, title: "Japan trip" } });
    expect(inDb).not.toBeNull();
  });

  it("triggers savings-plan generation so the detail screen doesn't spin forever", async () => {
    const r = await addGoal.run(proCtx, {
      title: "Laptop",
      target_amount: 1500,
      due_date: isoPlusDays(90),
    });
    expect(strategyMod.generateAndStoreGoalStrategy).toHaveBeenCalledWith(
      proCtx.env,
      r.goal.id,
    );
  });

  it("rejects a non-Pro user with upgrade_required", async () => {
    await expect(
      addGoal.run(freeCtx, { title: "X", target_amount: 100, due_date: isoPlusDays(60) }),
    ).rejects.toMatchObject({ code: "upgrade_required" });
  });

  it("rejects a due date sooner than one month at the arg-schema layer", () => {
    const tooSoon = new Date(minDueDateOneMonthUTC().getTime() - 5 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const parsed = addGoal.args.safeParse({ title: "X", target_amount: 100, due_date: tooSoon });
    expect(parsed.success).toBe(false);
  });
});
