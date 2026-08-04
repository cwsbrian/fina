import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/server.js";
import { HttpError } from "../src/auth/context.js";
import { prisma } from "../src/db.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { signUpAndGetCookie } from "./helpers/auth.js";
import { testEnv } from "./helpers/test-env.js";

describe("POST /me/distribution", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("requires an authenticated session", async () => {
    const verifier = { verify: vi.fn() };
    const app = await buildApp(testEnv(), {
      distribution: { appleAppTransactionVerifier: verifier },
    });

    const response = await app.inject({
      method: "POST",
      url: "/me/distribution",
      payload: { signedAppTransaction: "proof" },
    });

    expect(response.statusCode).toBe(401);
    expect(verifier.verify).not.toHaveBeenCalled();
    await app.close();
  });

  it("classifies a new TestFlight signup from verified Sandbox proof", async () => {
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        environment: "Sandbox",
        applicationVersion: "42",
      }),
    };
    const app = await buildApp(testEnv(), {
      distribution: { appleAppTransactionVerifier: verifier },
    });
    const user = await signUpAndGetCookie(app, { email: "testflight@example.com" });

    const response = await app.inject({
      method: "POST",
      url: "/me/distribution",
      headers: { cookie: user.cookie },
      payload: { signedAppTransaction: "apple-signed-proof" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      signupEnvironment: "TEST",
      platform: "ios",
      buildNumber: "42",
      storeEnvironment: "Sandbox",
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(stored).toMatchObject({
      signupEnvironment: "TEST",
      signupPlatform: "ios",
      signupBuildNumber: "42",
      appleStoreEnvironment: "Sandbox",
    });
    expect(stored.environmentVerifiedAt).toBeInstanceOf(Date);
    await app.close();
  });

  it("does not rewrite the first verified signup environment", async () => {
    const verifier = {
      verify: vi.fn().mockResolvedValue({
        environment: "Production",
        applicationVersion: "43",
      }),
    };
    const app = await buildApp(testEnv(), {
      distribution: { appleAppTransactionVerifier: verifier },
    });
    const user = await signUpAndGetCookie(app, { email: "immutable@example.com" });
    await prisma.user.update({
      where: { id: user.userId },
      data: {
        signupEnvironment: "TEST",
        signupPlatform: "ios",
        signupBuildNumber: "42",
        appleStoreEnvironment: "Sandbox",
        environmentVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/me/distribution",
      headers: { cookie: user.cookie },
      payload: { signedAppTransaction: "new-proof" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().signupEnvironment).toBe("TEST");
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(stored.signupEnvironment).toBe("TEST");
    expect(stored.signupBuildNumber).toBe("42");
    expect(stored.appleStoreEnvironment).toBe("Sandbox");
    await app.close();
  });

  it("rejects invalid bodies and failed Apple verification", async () => {
    const verifier = {
      verify: vi.fn().mockRejectedValue(new HttpError(400, "invalid_receipt")),
    };
    const app = await buildApp(testEnv(), {
      distribution: { appleAppTransactionVerifier: verifier },
    });
    const user = await signUpAndGetCookie(app, { email: "invalid-proof@example.com" });

    const invalidBody = await app.inject({
      method: "POST",
      url: "/me/distribution",
      headers: { cookie: user.cookie },
      payload: { signedAppTransaction: "proof", trustedEnvironment: "Production" },
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json().error).toBe("invalid_body");

    const invalidProof = await app.inject({
      method: "POST",
      url: "/me/distribution",
      headers: { cookie: user.cookie },
      payload: { signedAppTransaction: "forged" },
    });
    expect(invalidProof.statusCode).toBe(400);
    expect(invalidProof.json().error).toBe("invalid_receipt");
    await app.close();
  });
});
