import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { pauseDailyBrief } from "../src/chat/tools/pause-daily-brief.js";
import { testEnv } from "./helpers/test-env.js";

beforeEach(async () => { await truncateAll(); });
afterAll(async () => { await disconnect(); });

async function seed() {
  const u = await prisma.user.create({
    data: { id: `pdb-${Date.now()}`, email: `pdb-${Date.now()}@t.co`, name: "PDB", tz: "America/Toronto" },
  });
  const ws = await prisma.workspace.create({ data: { name: "Personal" } });
  await prisma.membership.create({ data: { userId: u.id, workspaceId: ws.id, role: "owner" } });
  return { u, ws };
}

describe("pauseDailyBrief tool", () => {
  it("sets snoozeUntil when `until` is provided", async () => {
    const { u, ws } = await seed();
    const result = await pauseDailyBrief.run(
      { env: testEnv(), workspaceId: ws.id, userId: u.id, role: "owner" },
      { until: "2026-06-15" },
    );
    expect(result.ok).toBe(true);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(updated.snoozeUntil).not.toBeNull();
    expect(updated.pauseEnabled).toBe(false);
  });

  it("sets pauseEnabled when `indefinite=true`", async () => {
    const { u, ws } = await seed();
    const result = await pauseDailyBrief.run(
      { env: testEnv(), workspaceId: ws.id, userId: u.id, role: "owner" },
      { indefinite: true },
    );
    expect(result.ok).toBe(true);
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(updated.pauseEnabled).toBe(true);
    expect(updated.snoozeUntil).toBeNull();
  });

  it("rejects when both `until` and `indefinite` are provided", async () => {
    const { u, ws } = await seed();
    const result = await pauseDailyBrief.run(
      { env: testEnv(), workspaceId: ws.id, userId: u.id, role: "owner" },
      { until: "2026-06-15", indefinite: true },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects when neither is provided", async () => {
    const { u, ws } = await seed();
    const result = await pauseDailyBrief.run(
      { env: testEnv(), workspaceId: ws.id, userId: u.id, role: "owner" },
      {},
    );
    expect(result.ok).toBe(false);
  });
});
