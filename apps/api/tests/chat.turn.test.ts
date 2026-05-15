import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatGeminiMock, resetGeminiMock } from "./helpers/gemini-mock.js";

const { geminiMockFactory: hoistedGeminiMockFactory } = await vi.hoisted(
  async () => await import("./helpers/gemini-mock.js"),
);
vi.mock("@google/genai", hoistedGeminiMockFactory);

import { prisma } from "../src/db.js";
import { processChatTurn } from "../src/chat/turn.js";

describe("processChatTurn", () => {
  let wsId: string;
  let threadId: string;
  let userId: string;
  const env = { GEMINI_API_KEY: "x" } as never;

  beforeEach(async () => {
    resetGeminiMock();
    const u = await prisma.user.create({ data: { id: `tr-${Date.now()}`, email: `tr-${Date.now()}@t.co`, name: "TR" } });
    userId = u.id;
    const ws = await prisma.workspace.create({ data: { name: "tr-ws" } });
    wsId = ws.id;
    await prisma.membership.create({ data: { userId, workspaceId: wsId, role: "owner" } });
    const thread = await prisma.chatThread.create({ data: { workspaceId: wsId, type: "adhoc" } });
    threadId = thread.id;
    await prisma.chatMessage.create({ data: { threadId, role: "user", blocks: [{ type: "text", markdown: "hi" }] } });
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: wsId } });
  });

  it("text-only response → returns assistantText, toolCalls empty", async () => {
    chatGeminiMock.responses.push({ text: "Hello!" });
    const r = await processChatTurn(env, { id: threadId, workspaceId: wsId }, userId);
    expect(r.assistantText).toBe("Hello!");
    expect(r.toolCalls).toHaveLength(0);
  });

  it("single function call → dispatched → final text", async () => {
    chatGeminiMock.responses.push({ functionCalls: [{ name: "listCategories", args: {} }] });
    chatGeminiMock.responses.push({ text: "You have 0 categories." });
    const r = await processChatTurn(env, { id: threadId, workspaceId: wsId }, userId);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].toolName).toBe("listCategories");
    expect(r.assistantText).toBe("You have 0 categories.");
    const toolRow = await prisma.chatMessage.findFirstOrThrow({ where: { threadId, role: "tool" } });
    const blocks = toolRow.blocks as Array<{ type: string; toolName: string }>;
    expect(blocks[0].toolName).toBe("listCategories");
  });

  it("parallel function calls in one round → both dispatched, both counted", async () => {
    chatGeminiMock.responses.push({ functionCalls: [{ name: "listCategories", args: {} }, { name: "listTransactions", args: {} }] });
    chatGeminiMock.responses.push({ text: "Summary." });
    const r = await processChatTurn(env, { id: threadId, workspaceId: wsId }, userId);
    expect(r.toolCalls).toHaveLength(2);
    const persisted = await prisma.chatMessage.count({ where: { threadId, role: "tool" } });
    expect(persisted).toBe(2);
  });

  it("exceeds MAX_TOOL_CALLS → apology", async () => {
    const env11 = { ...env, CHAT_MAX_TOOL_CALLS_PER_TURN: 2 } as never;
    for (let i = 0; i < 5; i++) {
      chatGeminiMock.responses.push({ functionCalls: [{ name: "listCategories", args: {} }] });
    }
    const r = await processChatTurn(env11, { id: threadId, workspaceId: wsId }, userId);
    expect(r.assistantText).toMatch(/couldn't complete/i);
  });

  it("missing fc.name in all calls of a round → bail with apology (no infinite loop)", async () => {
    chatGeminiMock.responses.push({ functionCalls: [{ args: {} }] });
    const r = await processChatTurn(env, { id: threadId, workspaceId: wsId }, userId);
    expect(r.assistantText).toMatch(/couldn't complete/i);
    expect(r.toolCalls).toHaveLength(0);
  });

  it("tool throws → LLM sees {error} → final text", async () => {
    chatGeminiMock.responses.push({ functionCalls: [{ name: "categorizeTransaction", args: { tx_id: "nope", category: "Coffee" } }] });
    chatGeminiMock.responses.push({ text: "I couldn't find that transaction." });
    const r = await processChatTurn(env, { id: threadId, workspaceId: wsId }, userId);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].result).toMatchObject({ error: expect.any(String) });
    expect(r.assistantText).toBe("I couldn't find that transaction.");
  });

  it("history rehydration: prior tool row → emits both functionCall + functionResponse", async () => {
    await prisma.chatMessage.create({
      data: { threadId, role: "tool", blocks: [{ type: "tool", toolName: "listCategories", args: {}, result: { output: { categories: [] } } }] },
    });
    chatGeminiMock.responses.push({ text: "ok" });
    const r = await processChatTurn(env, { id: threadId, workspaceId: wsId }, userId);
    expect(r.assistantText).toBe("ok");
    expect(r.toolCalls).toHaveLength(0);
  });

  it("Gemini SDK throws → exception propagates to caller", async () => {
    chatGeminiMock.responses.push(new Error("network kaput"));
    await expect(processChatTurn(env, { id: threadId, workspaceId: wsId }, userId)).rejects.toThrow(/network kaput/);
  });

  it("empty history (no rows) → throws chat_history_empty", async () => {
    await prisma.chatMessage.deleteMany({ where: { threadId } });
    await expect(processChatTurn(env, { id: threadId, workspaceId: wsId }, userId)).rejects.toThrow(/chat_history_empty/);
  });
});
