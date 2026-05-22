import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server.js";
import { testEnv } from "./helpers/test-env.js";

const env = testEnv();

describe("Helmet headers", () => {
  it("GET /health returns x-frame-options DENY and a strict CSP", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeDefined();
    expect(String(csp)).toContain("default-src 'none'");
    await app.close();
  });
});
