import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { generateAndPersistThreadTitle } from "../src/chat/auto-title.js";
import type { Env } from "../src/env.js";

// Mock the LLM call so tests don't hit Gemini.
vi.mock("../src/chat/auto-title-llm.js", () => ({
  callTitleLLM: vi.fn(),
}));

import { callTitleLLM } from "../src/chat/auto-title-llm.js";

const env = {
  GEMINI_API_KEY: "test-key",
  CHAT_MODEL: "gemini-2.5-flash-lite",
} as unknown as Env;

describe("[plan 1e-title] generateAndPersistThreadTitle", () => {
  let workspaceId: string;
  let threadId: string;

  beforeEach(async () => {
    vi.mocked(callTitleLLM).mockReset();
    const stamp = `at-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
    await prisma.user.create({ data: { id: stamp, email: `${stamp}@t.co`, name: "AT" } });
    const ws = await prisma.workspace.create({ data: { name: "at-ws" } });
    workspaceId = ws.id;
    await prisma.membership.create({ data: { userId: stamp, workspaceId, role: "owner" } });
    const t = await prisma.chatThread.create({ data: { userId: stamp, workspaceId, title: null } });
    threadId = t.id;
  });

  afterEach(async () => {
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  });

  it("persists a cleaned title from the LLM result on first message", async () => {
    vi.mocked(callTitleLLM).mockResolvedValue("Coffee 카테고리 추가");
    await generateAndPersistThreadTitle(env, threadId, stamp, "Coffee 카테고리 만들어줘");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBe("Coffee 카테고리 추가");
  });

  it("does NOT overwrite a manually-set title", async () => {
    await prisma.chatThread.update({ where: { id: threadId }, data: { title: "Manual" } });
    vi.mocked(callTitleLLM).mockResolvedValue("Auto Title");
    await generateAndPersistThreadTitle(env, threadId, stamp, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBe("Manual");
  });

  it("swallows LLM errors and leaves title NULL", async () => {
    vi.mocked(callTitleLLM).mockRejectedValue(new Error("rate-limit"));
    await generateAndPersistThreadTitle(env, threadId, stamp, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBeNull();
  });

  it("leaves title NULL when cleanTitle returns null (whitespace LLM output)", async () => {
    vi.mocked(callTitleLLM).mockResolvedValue("   \n   ");
    await generateAndPersistThreadTitle(env, threadId, stamp, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBeNull();
  });

  it("respects threadId boundary (wrong threadId → no update)", async () => {
    vi.mocked(callTitleLLM).mockResolvedValue("Should Not Land");
    await generateAndPersistThreadTitle(env, "wrong-thread-id", stamp, "first msg");
    const t = await prisma.chatThread.findUnique({ where: { id: threadId } });
    expect(t?.title).toBeNull();
  });
});
