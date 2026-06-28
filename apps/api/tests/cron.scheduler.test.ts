import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Mock croner so no real timers fire during tests.
vi.mock("croner", () => ({
  Cron: vi.fn().mockImplementation(() => ({ stop: vi.fn() })),
}));

// Mock job functions — we're testing wiring, not job logic.
vi.mock("../src/cron/jobs/daily-refresh.js", () => ({ runDailyRefresh: vi.fn() }));
vi.mock("../src/cron/jobs/retry-unprocessed.js", () => ({ runRetryUnprocessed: vi.fn() }));
vi.mock("../src/cron/jobs/cleanup-events.js", () => ({ runCleanupEvents: vi.fn() }));
vi.mock("../src/cron/jobs/scheduled-spend-match.js", () => ({ runScheduledSpendMatch: vi.fn() }));

import { Cron } from "croner";
import { startScheduler, stopScheduler, safe } from "../src/cron/scheduler.js";
import { runDailyRefresh } from "../src/cron/jobs/daily-refresh.js";
import * as loggerMod from "../src/logger.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

beforeEach(() => {
  vi.mocked(Cron).mockClear();
  stopScheduler(); // ensure clean state between tests
});

afterAll(() => {
  stopScheduler();
  vi.restoreAllMocks();
});

describe("scheduler", () => {
  it("CRON_ENABLED falsy → no Cron instances created", () => {
    startScheduler({ ...env }); // CRON_ENABLED undefined → falsy
    expect(Cron).not.toHaveBeenCalled();
  });

  it("CRON_ENABLED=true → registers the expected Cron jobs", () => {
    startScheduler({ ...env, CRON_ENABLED: true });
    expect(Cron).toHaveBeenCalledTimes(9);
    expect(vi.mocked(Cron).mock.calls.map((call) => call[1]?.name)).toEqual([
      "daily-brief",
      "push-receipts",
      "sweep-expired-intents",
      "daily-refresh",
      "retry-unprocessed",
      "cleanup-events",
      "scheduled-spend-match",
      "trial-expiring",
      "goal-milestones",
    ]);
  });

  it("stopScheduler calls stop() on all registered jobs", () => {
    startScheduler({ ...env, CRON_ENABLED: true });
    const instances = vi.mocked(Cron).mock.results.map((r) => r.value as { stop: ReturnType<typeof vi.fn> });
    stopScheduler();
    for (const inst of instances) {
      expect(inst.stop).toHaveBeenCalledOnce();
    }
  });

  it("stopScheduler is idempotent (safe to call when disabled)", () => {
    startScheduler({ ...env }); // disabled
    expect(() => stopScheduler()).not.toThrow();
  });

  it("safe() wrapper: job throw is caught, does not propagate", async () => {
    // Capture the callback passed to the daily-refresh Cron instance.
    // Plan 2B added daily-brief as the FIRST registered cron, pushing
    // daily-refresh to index 1 — so we capture by opts.name not by order.
    let capturedCallback: (() => Promise<void>) | undefined;
    vi.mocked(Cron).mockImplementation((_expr, opts, fn) => {
      if ((opts as { name?: string })?.name === "daily-refresh") {
        capturedCallback = fn as () => Promise<void>;
      }
      return { stop: vi.fn() } as unknown as Cron;
    });

    vi.mocked(runDailyRefresh).mockRejectedValueOnce(new Error("job failed"));
    startScheduler({ ...env, CRON_ENABLED: true });

    const errorSpy = vi.spyOn(loggerMod, "logError").mockImplementation(() => {});
    await expect(capturedCallback?.()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cron: "daily-refresh", event: "fail" }),
      expect.any(String),
    );
    errorSpy.mockRestore();
  });
});

describe("scheduler structured logs", () => {
  it("emits cron.event=start and cron.event=success on a successful run", async () => {
    const spyInfo = vi.spyOn(loggerMod, "logInfo").mockImplementation(() => {});

    await safe("daily-refresh", async () => {
      // no-op success
    });

    expect(spyInfo).toHaveBeenCalledWith(
      expect.objectContaining({ cron: "daily-refresh", event: "start" }),
      expect.any(String),
    );
    expect(spyInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        cron: "daily-refresh",
        event: "success",
        durationMs: expect.any(Number),
      }),
      expect.any(String),
    );
    spyInfo.mockRestore();
  });

  it("emits cron.event=fail with durationMs+err when the job throws", async () => {
    const spyInfo = vi.spyOn(loggerMod, "logInfo").mockImplementation(() => {});
    const spyError = vi.spyOn(loggerMod, "logError").mockImplementation(() => {});

    const boom = new Error("explode");
    await safe("retry-unprocessed", async () => {
      throw boom;
    });

    // start is still emitted before the throw.
    expect(spyInfo).toHaveBeenCalledWith(
      expect.objectContaining({ cron: "retry-unprocessed", event: "start" }),
      expect.any(String),
    );
    expect(spyError).toHaveBeenCalledWith(
      expect.objectContaining({
        cron: "retry-unprocessed",
        event: "fail",
        durationMs: expect.any(Number),
        err: boom,
      }),
      expect.any(String),
    );
    spyInfo.mockRestore();
    spyError.mockRestore();
  });
});
