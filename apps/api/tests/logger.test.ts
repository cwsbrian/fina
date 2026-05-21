import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import pino from "pino";

describe("logger module", () => {
  it("emits a JSON line with LogContext keys", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); },
    });
    const testLogger = pino({ level: "info" }, sink);
    testLogger.info({ workspaceId: "ws_1", userId: "u_1" }, "test");
    expect(lines).toHaveLength(1);
    const obj = JSON.parse(lines[0]!);
    expect(obj.workspaceId).toBe("ws_1");
    expect(obj.userId).toBe("u_1");
    expect(obj.msg).toBe("test");
  });

  it("logger module is silent in NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    const { logger } = await import("../src/logger.js");
    expect(logger.level).toBe("silent");
  });
});
