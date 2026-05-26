import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/server.js";
import { testEnv } from "../helpers/test-env.js";
import { makeIapMocks } from "../helpers/iap-mocks.js";

describe("buildApp IAP injection seam", () => {
  it("exposes injected iap clients on app.fina.iap when opts.iap is provided", async () => {
    const mocks = makeIapMocks();
    const app = await buildApp(testEnv(), { iap: mocks });
    expect((app as any).fina.iap).toBe(mocks);
    await app.close();
  });

  it("leaves app.fina.iap undefined by default (production wires real clients lazily)", async () => {
    const app = await buildApp(testEnv());
    expect((app as any).fina.iap).toBeUndefined();
    await app.close();
  });
});
