import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/schedules/match.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/schedules/match.js")>();
  return {
    ...actual,
    matchScheduledSpends: vi.fn().mockResolvedValue({ matched: 0, unresolved: 0 }),
  };
});

import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";
import * as matchMod from "../src/schedules/match.js";
import { runScheduledSpendMatch } from "../src/cron/jobs/scheduled-spend-match.js";

const env = testEnv();

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => { await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.clearAllMocks(); });

let counter = 0;
async function createWorkspace(): Promise<string> {
  counter++;
  const ws = await prisma.workspace.create({
    data: { id: `ssm-w-${Date.now()}-${counter}`, name: `SSM WS ${counter}`, currency: "CAD" },
  });
  return ws.id;
}

describe("runScheduledSpendMatch", () => {
  it("no workspaces → matchScheduledSpends not called", async () => {
    await runScheduledSpendMatch(env);
    expect(vi.mocked(matchMod.matchScheduledSpends)).toHaveBeenCalledTimes(0);
  });

  it("1 workspace → called once with (wsId, today: Date)", async () => {
    const wsId = await createWorkspace();
    vi.mocked(matchMod.matchScheduledSpends).mockResolvedValue({ matched: 3, unresolved: 1 });

    await runScheduledSpendMatch(env);

    const calls = vi.mocked(matchMod.matchScheduledSpends).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(wsId);
    expect(calls[0]?.[1]).toBeInstanceOf(Date);
  });

  it("first workspace throws → second STILL called (per-workspace containment)", async () => {
    await createWorkspace();
    await createWorkspace();
    vi.mocked(matchMod.matchScheduledSpends)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ matched: 0, unresolved: 0 });

    await expect(runScheduledSpendMatch(env)).resolves.toBeUndefined();

    expect(vi.mocked(matchMod.matchScheduledSpends)).toHaveBeenCalledTimes(2);
  });
});
