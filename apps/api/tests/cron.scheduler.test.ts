import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Mock croner so no real timers fire during tests.
vi.mock("croner", () => ({
  Cron: vi.fn().mockImplementation(() => ({ stop: vi.fn() })),
}));

// Mock job functions — we're testing wiring, not job logic.
vi.mock("../src/cron/jobs/daily-refresh.js", () => ({ runDailyRefresh: vi.fn() }));
vi.mock("../src/cron/jobs/retry-unprocessed.js", () => ({ runRetryUnprocessed: vi.fn() }));
vi.mock("../src/cron/jobs/cleanup-events.js", () => ({ runCleanupEvents: vi.fn() }));

import { Cron } from "croner";
import { startScheduler, stopScheduler } from "../src/cron/scheduler.js";
import { runDailyRefresh } from "../src/cron/jobs/daily-refresh.js";

const env = {
  NODE_ENV: "test" as const,
  PORT: 0,
  DATABASE_URL: "postgresql://x",
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

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

  it("CRON_ENABLED=true → exactly 3 Cron instances created", () => {
    startScheduler({ ...env, CRON_ENABLED: true });
    expect(Cron).toHaveBeenCalledTimes(3);
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
    // Capture the callback passed to the first Cron instance (daily-refresh).
    let capturedCallback: (() => Promise<void>) | undefined;
    vi.mocked(Cron).mockImplementationOnce((_expr, _opts, fn) => {
      capturedCallback = fn as () => Promise<void>;
      return { stop: vi.fn() };
    });

    vi.mocked(runDailyRefresh).mockRejectedValueOnce(new Error("job failed"));
    startScheduler({ ...env, CRON_ENABLED: true });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(capturedCallback?.()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(
      "cron job uncaught",
      expect.objectContaining({ jobName: "daily-refresh" }),
    );
    errorSpy.mockRestore();
  });
});
