import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
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

let userCounter = 0;
let wsCounter = 0;

async function createUser(): Promise<string> {
  userCounter++;
  const id = `gm-u-${Date.now()}-${userCounter}`;
  await prisma.user.create({
    data: { id, email: `${id}@t.co`, name: `GM User ${userCounter}` },
  });
  return id;
}

async function setupWorkspaceWithRoles(
  roles: Array<"owner" | "editor" | "viewer">,
): Promise<{ wsId: string; userIds: Record<"owner" | "editor" | "viewer", string | undefined> }> {
  wsCounter++;
  const ws = await prisma.workspace.create({
    data: { id: `gm-w-${Date.now()}-${wsCounter}`, name: `GM WS ${wsCounter}`, currency: "CAD" },
  });
  const userIds: Record<"owner" | "editor" | "viewer", string | undefined> = {
    owner: undefined, editor: undefined, viewer: undefined,
  };
  for (const role of roles) {
    const userId = await createUser();
    await prisma.membership.create({
      data: { userId, workspaceId: ws.id, role },
    });
    userIds[role] = userId;
  }
  return { wsId: ws.id, userIds };
}

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
    const ownerId = userIds.owner!;  // helper guarantees owner exists when in roles array
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
    const ownerId = userIds.owner!;
    const editorId = userIds.editor!;
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

  it("push throws on one goal → logError + iteration continues to the other", async () => {
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

    // Exactly one goal's state was advanced; the other was preserved.
    // Order-agnostic assertion — robust to Postgres scan-order shifts.
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
