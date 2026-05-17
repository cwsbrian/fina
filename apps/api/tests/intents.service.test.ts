import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  createIntentService,
  consumeIntentService,
  CONFIRMABLE_TOOLS,
} from "../src/intents/service.js";

describe("createIntentService", () => {
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `ic-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "IC", tz: "America/Toronto" },
    });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "ic-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("creates a row with expiresAt ≈ now + 1 hour", async () => {
    const before = Date.now();
    const r = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Coffee" } },
    );
    const row = await prisma.actionIntent.findUnique({ where: { id: r.intent.id } });
    expect(row).not.toBeNull();
    expect(row?.consumedAt).toBeNull();
    const delta = row!.expiresAt.getTime() - before;
    expect(delta).toBeGreaterThanOrEqual(3_600_000 - 5_000);
    expect(delta).toBeLessThanOrEqual(3_600_000 + 5_000);
  });

  it("rejects a tool not in CONFIRMABLE_TOOLS → invalid_tool", async () => {
    await expect(
      createIntentService(
        { workspaceId, userId },
        { tool: "listTransactions", args: { period: "this_month" } },
      ),
    ).rejects.toThrow("invalid_tool");
  });

  it("rejects args failing target tool's Zod schema → invalid_payload_args", async () => {
    await expect(
      createIntentService(
        { workspaceId, userId },
        { tool: "createCategory", args: { name: "" } },
      ),
    ).rejects.toThrow("invalid_payload_args");
  });
});

describe("consumeIntentService", () => {
  let workspaceId: string;
  let userId: string;
  let env: { GEMINI_API_KEY: string; CHAT_MODEL: string };

  beforeEach(async () => {
    const stamp = `iv-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "IV", tz: "America/Toronto" },
    });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "iv-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    env = { GEMINI_API_KEY: "test-key", CHAT_MODEL: "gemini-2.5-flash-lite" };
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("happy path: dispatches createCategory, returns result, marks consumed", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Coffee" } },
    );
    const r = await consumeIntentService(
      { workspaceId, userId, role: "owner", env: env as never },
      intent.id,
    );
    expect(r.result).toMatchObject({ category: { name: "Coffee" } });
    const row = await prisma.actionIntent.findUnique({ where: { id: intent.id } });
    expect(row?.consumedAt).not.toBeNull();
  });

  it("intent_not_found for nonexistent id", async () => {
    await expect(
      consumeIntentService(
        { workspaceId, userId, role: "owner", env: env as never },
        "does-not-exist",
      ),
    ).rejects.toThrow("intent_not_found");
  });

  it("intent_owner_mismatch on cross-workspace", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "X" } },
    );
    await expect(
      consumeIntentService(
        { workspaceId: "other-ws", userId, role: "owner", env: env as never },
        intent.id,
      ),
    ).rejects.toThrow("intent_owner_mismatch");
  });

  it("intent_owner_mismatch when different user in same workspace", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "X" } },
    );
    await expect(
      consumeIntentService(
        { workspaceId, userId: "another-user", role: "owner", env: env as never },
        intent.id,
      ),
    ).rejects.toThrow("intent_owner_mismatch");
  });

  it("intent_gone for already-consumed", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Once" } },
    );
    await consumeIntentService(
      { workspaceId, userId, role: "owner", env: env as never },
      intent.id,
    );
    await expect(
      consumeIntentService(
        { workspaceId, userId, role: "owner", env: env as never },
        intent.id,
      ),
    ).rejects.toThrow("intent_gone");
  });

  it("intent_gone for expired", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Expired" } },
    );
    await prisma.actionIntent.update({
      where: { id: intent.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      consumeIntentService(
        { workspaceId, userId, role: "owner", env: env as never },
        intent.id,
      ),
    ).rejects.toThrow("intent_gone");
  });

  it("race-safe: two concurrent consumes — exactly one wins", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "Race" } },
    );
    const results = await Promise.allSettled([
      consumeIntentService({ workspaceId, userId, role: "owner", env: env as never }, intent.id),
      consumeIntentService({ workspaceId, userId, role: "owner", env: env as never }, intent.id),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toBe("intent_gone");
  });
});
