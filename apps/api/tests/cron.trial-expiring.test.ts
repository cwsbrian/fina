import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as sendMod from "../src/push/send.js";

const env = testEnv();

vi.mock("../src/push/send.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/push/send.js")>();
  return {
    ...actual,
    sendTrialExpiringPush: vi.fn().mockResolvedValue({ sent: 0, failed: 0 }),
  };
});

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

let userCounter = 0;

async function createTrialUser(opts: {
  trialEndsAt: Date | null;
  trialConsumed?: boolean;
  lastTrialPushDays?: number | null;
}): Promise<string> {
  userCounter++;
  const id = `te-${Date.now()}-${userCounter}`;
  await prisma.user.create({
    data: {
      id,
      email: `${id}@t.co`,
      name: `Trial ${userCounter}`,
      trialEndsAt: opts.trialEndsAt,
      trialConsumed: opts.trialConsumed ?? false,
      lastTrialPushDays: opts.lastTrialPushDays ?? null,
    },
  });
  return id;
}

/** Build a trialEndsAt that places daysLeft exactly at `dayCount` after
 *  Math.ceil. Subtract 1 hour so the ceil rounds up cleanly. */
function trialEndsAtForDaysLeft(dayCount: number): Date {
  return new Date(Date.now() + dayCount * 86_400_000 - 3_600_000);
}

describe("runTrialExpiring", () => {
  it("no candidates → no push", async () => {
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });

  it("trialEndsAt in the past → no push", async () => {
    await createTrialUser({ trialEndsAt: new Date(Date.now() - 86_400_000) });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });

  it("trialConsumed=true → filtered out by query", async () => {
    await createTrialUser({
      trialEndsAt: trialEndsAtForDaysLeft(3),
      trialConsumed: true,
    });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });

  it("daysLeft=4 (no threshold) → no push", async () => {
    await createTrialUser({ trialEndsAt: trialEndsAtForDaysLeft(4) });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });

  it("daysLeft=5, never pushed → push + lastTrialPushDays=5", async () => {
    const userId = await createTrialUser({ trialEndsAt: trialEndsAtForDaysLeft(5) });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    const calls = vi.mocked(sendMod.sendTrialExpiringPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([env, userId, 5]);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(fresh.lastTrialPushDays).toBe(5);
  });

  it("daysLeft=5, lastTrialPushDays=5 → no push (already sent)", async () => {
    await createTrialUser({
      trialEndsAt: trialEndsAtForDaysLeft(5),
      lastTrialPushDays: 5,
    });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(0);
  });

  it("daysLeft=3, lastTrialPushDays=5 → push + lastTrialPushDays=3", async () => {
    const userId = await createTrialUser({
      trialEndsAt: trialEndsAtForDaysLeft(3),
      lastTrialPushDays: 5,
    });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    const calls = vi.mocked(sendMod.sendTrialExpiringPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([env, userId, 3]);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(fresh.lastTrialPushDays).toBe(3);
  });

  it("daysLeft=1 (final 24h) → push + lastTrialPushDays=1", async () => {
    const userId = await createTrialUser({ trialEndsAt: trialEndsAtForDaysLeft(1) });
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);
    const calls = vi.mocked(sendMod.sendTrialExpiringPush).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([env, userId, 1]);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(fresh.lastTrialPushDays).toBe(1);
  });

  it("push throws → logError, no state mutation", async () => {
    const userId = await createTrialUser({ trialEndsAt: trialEndsAtForDaysLeft(5) });
    vi.mocked(sendMod.sendTrialExpiringPush).mockRejectedValueOnce(new Error("boom"));
    const { runTrialExpiring } = await import("../src/cron/jobs/trial-expiring.js");
    await runTrialExpiring(env);  // does NOT throw — catch swallows
    expect(vi.mocked(sendMod.sendTrialExpiringPush)).toHaveBeenCalledTimes(1);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(fresh.lastTrialPushDays).toBeNull();  // state NOT advanced on failure
  });
});
