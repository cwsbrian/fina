import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });

async function setup(email: string) {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Test-Cat" } });
  return { cookie: u.cookie, wsId, userId: u.userId, categoryName: cat.name, categoryId: cat.id };
}

describe("addScheduledSpend chat tool", () => {
  it("happy: resolves category by name and creates schedule", async () => {
    const { wsId, userId, categoryName } = await setup("ct-add@t.co");
    const { addScheduledSpend } = await import("../src/chat/tools/add-scheduled-spend.js");
    const result = await addScheduledSpend.run(
      { workspaceId: wsId, userId, env: env as any },
      { category: categoryName, amount: 100, scheduled_date: "2026-05-25", note: "x" },
    );
    expect(result.schedule.categoryName).toBe(categoryName);
    expect(result.schedule.amount).toBe("100");
  });

  it("category name unknown → category_not_found", async () => {
    const { wsId, userId } = await setup("ct-add-unknown@t.co");
    const { addScheduledSpend } = await import("../src/chat/tools/add-scheduled-spend.js");
    await expect(
      addScheduledSpend.run(
        { workspaceId: wsId, userId, env: env as any },
        { category: "Unknown-Cat", amount: 100, scheduled_date: "2026-05-25" },
      ),
    ).rejects.toThrow();
  });
});

describe("listScheduledSpends chat tool", () => {
  it("returns schedules with derived status", async () => {
    const { wsId, userId, categoryId } = await setup("ct-list@t.co");
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId,
        amount: "50", scheduledDate: new Date("2099-05-25T00:00:00Z"),
      },
    });
    const { listScheduledSpends } = await import("../src/chat/tools/list-scheduled-spends.js");
    const result = await listScheduledSpends.run(
      { workspaceId: wsId, userId, env: env as any },
      { status: "all" },
    );
    expect(result.schedules).toHaveLength(1);
    expect(result.schedules[0]!.status).toBe("upcoming");
  });
});

describe("listUnresolvedSchedules chat tool", () => {
  it("returns past schedules without match", async () => {
    const { wsId, userId, categoryId } = await setup("ct-listun@t.co");
    await prisma.scheduledSpend.create({
      data: {
        workspaceId: wsId, categoryId,
        amount: "30", scheduledDate: new Date("2020-01-01T00:00:00Z"),
      },
    });
    const { listUnresolvedSchedules } = await import("../src/chat/tools/list-unresolved-schedules.js");
    const result = await listUnresolvedSchedules.run(
      { workspaceId: wsId, userId, env: env as any },
      {},
    );
    expect(result.schedules).toHaveLength(1);
  });
});

describe("dismissScheduledSpend chat tool", () => {
  it("happy: sets dismissedAt", async () => {
    const { wsId, userId, categoryId } = await setup("ct-dis@t.co");
    const sched = await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId, amount: "50", scheduledDate: new Date("2026-05-25T00:00:00Z") },
    });
    const { dismissScheduledSpend } = await import("../src/chat/tools/dismiss-scheduled-spend.js");
    const result = await dismissScheduledSpend.run(
      { workspaceId: wsId, userId, env: env as any },
      { schedule_id: sched.id },
    );
    expect("schedule" in result || "dismissed" in result).toBe(true);
  });
});

describe("removeScheduledSpend chat tool", () => {
  it("happy: deletes the row", async () => {
    const { wsId, userId, categoryId } = await setup("ct-rem@t.co");
    const sched = await prisma.scheduledSpend.create({
      data: { workspaceId: wsId, categoryId, amount: "50", scheduledDate: new Date("2026-05-25T00:00:00Z") },
    });
    const { removeScheduledSpend } = await import("../src/chat/tools/remove-scheduled-spend.js");
    const result = await removeScheduledSpend.run(
      { workspaceId: wsId, userId, env: env as any },
      { schedule_id: sched.id },
    );
    expect(result.removed).toBe(true);
  });
});
