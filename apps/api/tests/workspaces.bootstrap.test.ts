import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { startTrialAndBootstrapWorkspace } from "../src/workspaces/bootstrap.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("startTrialAndBootstrapWorkspace", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await disconnect();
  });

  it("creates workspace + owner membership + 30d trial for an existing user", async () => {
    const u = await prisma.user.create({
      data: { id: "user_1", email: "brian@example.com", emailVerified: true, name: "Brian" },
    });

    const before = Date.now();
    const result = await startTrialAndBootstrapWorkspace({ userId: u.id });
    const after = Date.now();

    expect(result.workspace.name).toBe("Brian's workspace");
    expect(result.membership.role).toBe("owner");

    const userAfter = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(userAfter.trialStartedAt).not.toBeNull();
    expect(userAfter.trialEndsAt).not.toBeNull();
    const trialStart = userAfter.trialStartedAt!.getTime();
    const trialEnd = userAfter.trialEndsAt!.getTime();
    expect(trialStart).toBeGreaterThanOrEqual(before);
    expect(trialStart).toBeLessThanOrEqual(after);
    expect(trialEnd - trialStart).toBeGreaterThan(30 * 24 * 60 * 60 * 1000 - 1000);
    expect(trialEnd - trialStart).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 1000);
    expect(userAfter.trialConsumed).toBe(false);

    const memberships = await prisma.membership.findMany({ where: { userId: u.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]?.workspaceId).toBe(result.workspace.id);
  });

  it("is idempotent — running twice does not create extra workspace or restart trial", async () => {
    const u = await prisma.user.create({
      data: { id: "user_dup", email: "dup@example.com", emailVerified: true, name: "Dup" },
    });
    const first = await startTrialAndBootstrapWorkspace({ userId: u.id });
    const firstUser = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    const firstStart = firstUser.trialStartedAt!.getTime();

    await new Promise((r) => setTimeout(r, 5));

    const second = await startTrialAndBootstrapWorkspace({ userId: u.id });
    expect(second.workspace.id).toBe(first.workspace.id);

    const secondUser = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(secondUser.trialStartedAt!.getTime()).toBe(firstStart);
    expect(await prisma.workspace.count()).toBe(1);
    expect(await prisma.membership.count()).toBe(1);
  });

  it("falls back to email-derived workspace name when name is null", async () => {
    const u = await prisma.user.create({
      data: { id: "user_no_name", email: "alice@example.com", emailVerified: true, name: null },
    });
    const result = await startTrialAndBootstrapWorkspace({ userId: u.id });
    expect(result.workspace.name).toBe("alice's workspace");
  });
});
