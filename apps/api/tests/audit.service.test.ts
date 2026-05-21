import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatGeminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import {
  AUDIT_WRITE_TOOLS,
  resolveTargetType,
  extractTargetId,
  logAuditEvent,
} from "../src/audit/service.js";
import { createIntentService, consumeIntentService } from "../src/intents/service.js";
import { processChatTurn } from "../src/chat/turn.js";

describe("resolveTargetType", () => {
  it("maps createCategory → 'category'", () => {
    expect(resolveTargetType("createCategory")).toBe("category");
  });
  it("maps removeRecurring → 'recurring_expense'", () => {
    expect(resolveTargetType("removeRecurring")).toBe("recurring_expense");
  });
  it("maps mapMerchantToCategory → 'merchant_mapping'", () => {
    expect(resolveTargetType("mapMerchantToCategory")).toBe("merchant_mapping");
  });
  it("returns null for unknown action", () => {
    expect(resolveTargetType("unknownTool")).toBeNull();
  });
});

describe("extractTargetId", () => {
  it("extracts id from createCategory result", () => {
    expect(
      extractTargetId("createCategory", { category: { id: "c1", name: "Coffee" } }),
    ).toBe("c1");
  });
  it("extracts id from addRecurring result", () => {
    expect(
      extractTargetId("addRecurring", { recurring: { id: "r1", name: "Netflix" } }),
    ).toBe("r1");
  });
  it("returns null for removeRecurring (row deleted)", () => {
    expect(extractTargetId("removeRecurring", { removed: true })).toBeNull();
  });
  it("returns null for mapMerchantToCategory (no row id)", () => {
    expect(
      extractTargetId("mapMerchantToCategory", {
        mapping: { merchantNormalized: "starbucks", categoryId: "c1", categoryName: "Coffee" },
        backfilledCount: 2,
      }),
    ).toBeNull();
  });
  it("returns null for missing or malformed result", () => {
    expect(extractTargetId("createCategory", null)).toBeNull();
    expect(extractTargetId("createCategory", {})).toBeNull();
  });
});

describe("logAuditEvent", () => {
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `au-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "AU", tz: "America/Toronto" },
    });
    userId = stamp;
    const ws = await prisma.workspace.create({ data: { name: "au-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("inserts a row with correct fields", async () => {
    await logAuditEvent({
      workspaceId,
      actorType: "agent",
      actorUserId: userId,
      action: "createCategory",
      targetType: "category",
      targetId: "c1",
      payload: { name: "Coffee" },
      result: { category: { id: "c1", name: "Coffee" } },
    });
    const row = await prisma.auditEvent.findFirst({ where: { workspaceId } });
    expect(row).not.toBeNull();
    expect(row?.actorType).toBe("agent");
    expect(row?.actorUserId).toBe(userId);
    expect(row?.action).toBe("createCategory");
    expect(row?.targetType).toBe("category");
    expect(row?.targetId).toBe("c1");
    expect(row?.intentId).toBeNull();
  });

  it("includes intentId when provided", async () => {
    await logAuditEvent({
      workspaceId,
      actorType: "user",
      actorUserId: userId,
      action: "removeRecurring",
      intentId: "int-123",
      result: { removed: true },
    });
    const row = await prisma.auditEvent.findFirst({ where: { workspaceId } });
    expect(row?.intentId).toBe("int-123");
    expect(row?.actorType).toBe("user");
  });

  it("does NOT throw when workspace does not exist (FK error caught internally)", async () => {
    await expect(
      logAuditEvent({
        workspaceId: "does-not-exist",
        actorType: "agent",
        actorUserId: userId,
        action: "createCategory",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("AUDIT_WRITE_TOOLS", () => {
  it("contains all 10 expected tool names", () => {
    for (const t of [
      "categorizeTransaction",
      "createCategory",
      "addTransactionNote",
      "setBudget",
      "mapMerchantToCategory",
      "addRecurring",
      "removeRecurring",
      "addScheduledSpend",
      "dismissScheduledSpend",
      "removeScheduledSpend",
    ]) {
      expect(AUDIT_WRITE_TOOLS.has(t)).toBe(true);
    }
  });
  it("does NOT contain presentConfirmCard", () => {
    expect(AUDIT_WRITE_TOOLS.has("presentConfirmCard")).toBe(false);
  });
});

// Polling helper — avoids waitFor API (not available as named export in all vitest versions)
async function pollAuditRow(wsId: string, maxMs = 2000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = await prisma.auditEvent.findFirst({ where: { workspaceId: wsId } });
    if (r) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("audit row never appeared");
}

describe("audit hook — intent consume (actorType: user)", () => {
  let workspaceId: string;
  let userId: string;

  beforeEach(async () => {
    const stamp = `ih-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "IH", tz: "America/Toronto" },
    });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "ih-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("consumeIntentService creates an audit row with actorType=user and intentId set", async () => {
    const { intent } = await createIntentService(
      { workspaceId, userId },
      { tool: "createCategory", args: { name: "AuditMe" } },
    );
    await consumeIntentService(
      {
        workspaceId,
        userId,
        role: "owner",
        env: { GEMINI_API_KEY: "test-key", CHAT_MODEL: "gemini-2.5-flash-lite" } as never,
      },
      intent.id,
    );
    // yield event loop so the void logAuditEvent promise can start executing
    await new Promise((r) => setTimeout(r, 0));
    const row = await pollAuditRow(workspaceId, 5000);
    expect(row.actorType).toBe("user");
    expect(row.actorUserId).toBe(userId);
    expect(row.action).toBe("createCategory");
    expect(row.intentId).toBe(intent.id);
    expect(row.targetType).toBe("category");
  });
});

describe("audit hook — processChatTurn direct write (actorType: agent)", () => {
  let workspaceId: string;
  let userId: string;
  let threadId: string;
  const env = { GEMINI_API_KEY: "x" } as never;

  beforeEach(async () => {
    resetGeminiMock();
    const stamp = `ct-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    const u = await prisma.user.create({
      data: { id: stamp, email: `${stamp}@t.co`, name: "CT", tz: "America/Toronto" },
    });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "ct-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId, role: "owner" } });
    const thread = await prisma.chatThread.create({ data: { userId, workspaceId } });
    threadId = thread.id;
    await prisma.chatMessage.create({
      data: { threadId, role: "user", blocks: [{ type: "text", markdown: "make me a Coffee cat" }] },
    });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("processChatTurn write tool fires an audit row with actorType=agent", async () => {
    chatGeminiMock.responses.push({
      functionCalls: [{ name: "createCategory", args: { name: "Coffee" } }],
    });
    chatGeminiMock.responses.push({ text: "Coffee category created." });

    await processChatTurn(env, { id: threadId, workspaceId }, userId, "owner");

    const row = await pollAuditRow(workspaceId);
    expect(row.actorType).toBe("agent");
    expect(row.actorUserId).toBe(userId);
    expect(row.action).toBe("createCategory");
    expect(row.targetType).toBe("category");
  });
});
