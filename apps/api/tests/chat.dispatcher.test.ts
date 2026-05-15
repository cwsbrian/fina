import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { dispatchTool } from "../src/chat/dispatcher.js";
import type { ToolContext, ToolDef } from "../src/chat/tools/types.js";

const FAKE_CTX = { env: {}, workspaceId: "ws1", userId: "u1" } as ToolContext;

const echo: ToolDef = {
  name: "echo",
  description: "echo",
  args: z.object({ msg: z.string() }),
  run: async (_ctx, args) => ({ echoed: (args as { msg: string }).msg }),
};

const zeroArg: ToolDef = {
  name: "ping",
  description: "ping",
  args: z.object({}),
  run: async () => ({ pong: true }),
};

const exploder: ToolDef = {
  name: "boom",
  description: "boom",
  args: z.object({}),
  run: async () => { throw new Error("kapow"); },
};

describe("dispatchTool", () => {
  it("returns ok+result on valid args", async () => {
    const res = await dispatchTool(FAKE_CTX, "echo", { msg: "hi" }, [echo]);
    expect(res).toEqual({ ok: true, result: { echoed: "hi" } });
  });

  it("returns error on unknown tool", async () => {
    const res = await dispatchTool(FAKE_CTX, "missing", {}, [echo]);
    expect(res).toEqual({ ok: false, error: "unknown_tool: missing" });
  });

  it("returns error on invalid args", async () => {
    const res = await dispatchTool(FAKE_CTX, "echo", { msg: 42 }, [echo]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid_args/);
  });

  it("coerces undefined args to {} for zero-arg tools", async () => {
    const res = await dispatchTool(FAKE_CTX, "ping", undefined, [zeroArg]);
    expect(res).toEqual({ ok: true, result: { pong: true } });
  });

  it("catches tool throws and returns error without rethrow", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await dispatchTool(FAKE_CTX, "boom", {}, [exploder]);
    expect(res).toEqual({ ok: false, error: "kapow" });
    spy.mockRestore();
  });
});
