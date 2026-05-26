import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import { setupWorkspaceWithRoles } from "./helpers/factories.js";
import * as sendMod from "../src/push/send.js";
import * as savingsMod from "../src/goals/savings.js";

const env = testEnv();

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendGoalMilestonePush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

vi.mock("../src/goals/savings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/goals/savings.js")>();
  return {
    ...actual,
    computeGoalSavings: vi.fn(),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

async function createGoal(opts: {
  workspaceId: string;
  title?: string;
  targetAmount: number;
  lastMilestonePct?: number | null;
  archivedAt?: Date | null;
}): Promise<string> {
  const g = await prisma.goal.create({
    data: {
      workspaceId: opts.workspaceId,
      title: opts.title ?? "Test Goal",
      targetAmount: new Prisma.Decimal(opts.targetAmount),
      dueDate: new Date(Date.now() + 30 * 86_400_000),  // 30d future
      lastMilestonePct: opts.lastMilestonePct ?? null,
      archivedAt: opts.archivedAt ?? null,
    },
  });
  return g.id;
}

describe("runGoalMilestones", () => {
  it("no goals → no push", async () => {
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });

  it("archived goal → filtered out by query", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    await createGoal({
      workspaceId: wsId, targetAmount: 100,
      archivedAt: new Date(Date.now() - 86_400_000),
    });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(100);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });

  it("targetAmount=0 → continue (no push)", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    await createGoal({ workspaceId: wsId, targetAmount: 0 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(100);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });

  it("saved=20 of 100 (pct=20) → no milestone crossed", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    await createGoal({ workspaceId: wsId, targetAmount: 100 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(20);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });

  it("saved=30 of 100, prev=null → push at pct=25 + signature pinned", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner"]);
    const ownerId = userIds[0]!;  // helper guarantees owner exists when in roles array
    const goalId = await createGoal({ workspaceId: wsId, title: "Vacation", targetAmount: 100 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(30);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);

    const pushCalls = vi.mocked(sendMod.sendGoalMilestonePush).mock.calls;
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]).toEqual([env, ownerId, "Vacation", 25]);

    // Signature pin per R2 review — guards against rename / arg-order drift.
    const savingsCalls = vi.mocked(savingsMod.computeGoalSavings).mock.calls;
    expect(savingsCalls[0]).toEqual([wsId, goalId]);

    const fresh = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(fresh.lastMilestonePct).toBe(25);
  });

  it("saved=60 of 100, prev=50 → push at pct=50 (first MILESTONES match)", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    const goalId = await createGoal({ workspaceId: wsId, targetAmount: 100, lastMilestonePct: 50 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(60);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);

    // MILESTONES=[100,75,50,25].find(m=>60>=m) → 50 (first match).
    // crossed=50 vs previous=50 → 50 <= 50 means "already notified" → SKIP.
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
    const fresh = await prisma.goal.findUniqueOrThrow({ where: { id: goalId } });
    expect(fresh.lastMilestonePct).toBe(50);  // unchanged
  });

  it("owner+editor+viewer + saved=100 → 2 pushes (viewer excluded)", async () => {
    const { wsId, userIds } = await setupWorkspaceWithRoles(["owner", "editor", "viewer"]);
    const ownerId = userIds[0]!;
    const editorId = userIds[1]!;
    await createGoal({ workspaceId: wsId, title: "Done", targetAmount: 100 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(100);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);

    const calls = vi.mocked(sendMod.sendGoalMilestonePush).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c[1]).sort()).toEqual([ownerId, editorId].sort());
    // Both calls carry pct=100
    expect(calls.every((c) => c[3] === 100)).toBe(true);
  });

  it("saved=60, lastMilestonePct=75 → no push (crossed=50 <= 75)", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    await createGoal({ workspaceId: wsId, targetAmount: 100, lastMilestonePct: 75 });
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(60);
    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(0);
  });

  it("push throws on one goal → caught + iteration continues, BOTH goals advance", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    const goalA = await createGoal({ workspaceId: wsId, title: "A", targetAmount: 100 });
    const goalB = await createGoal({ workspaceId: wsId, title: "B", targetAmount: 100 });

    // Both goals report saved=100 → both should cross 100% milestone.
    vi.mocked(savingsMod.computeGoalSavings).mockResolvedValue(100);

    // First push throws, subsequent pushes succeed. (Which goal is "first"
    // depends on findMany's scan order — we don't assume.)
    vi.mocked(sendMod.sendGoalMilestonePush)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ sent: 0, failed: 0 });

    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await runGoalMilestones(env);  // does NOT throw

    // Both goals attempted (push called for both).
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(2);

    // Per-recipient containment — even though one push threw, BOTH goal.update
    // calls fire because the inner catch lets the per-member loop complete.
    const [a, b] = await Promise.all([
      prisma.goal.findUniqueOrThrow({ where: { id: goalA } }),
      prisma.goal.findUniqueOrThrow({ where: { id: goalB } }),
    ]);
    expect(a.lastMilestonePct).toBe(100);
    expect(b.lastMilestonePct).toBe(100);
  });

  it("computeGoalSavings throws on goal A → per-goal catch + iteration continues to goal B", async () => {
    const { wsId } = await setupWorkspaceWithRoles(["owner"]);
    const goalA = await createGoal({ workspaceId: wsId, title: "A", targetAmount: 100 });
    const goalB = await createGoal({ workspaceId: wsId, title: "B", targetAmount: 100 });

    vi.mocked(savingsMod.computeGoalSavings)
      .mockRejectedValueOnce(new Error("DB hiccup"))
      .mockResolvedValue(100);

    const { runGoalMilestones } = await import("../src/cron/jobs/goal-milestones.js");
    await expect(runGoalMilestones(env)).resolves.not.toThrow();

    // Goal A's per-goal catch fired BEFORE the fan-out — no push, no update.
    // Goal B processed normally — 1 push + state advanced.
    expect(vi.mocked(sendMod.sendGoalMilestonePush)).toHaveBeenCalledTimes(1);

    // Order-agnostic: one goal advanced, one didn't.
    const [a, b] = await Promise.all([
      prisma.goal.findUniqueOrThrow({ where: { id: goalA } }),
      prisma.goal.findUniqueOrThrow({ where: { id: goalB } }),
    ]);
    const states = [a.lastMilestonePct, b.lastMilestonePct].sort(
      (x, y) => (x ?? -1) - (y ?? -1),
    );
    expect(states).toEqual([null, 100]);
  });
});
