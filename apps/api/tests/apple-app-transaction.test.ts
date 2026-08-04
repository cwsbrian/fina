import { describe, expect, it } from "vitest";
import { createAppleAppTransactionVerifier } from "../src/distribution/apple-app-transaction.js";

function unsignedJws(receiptType: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ receiptType })).toString("base64url");
  return `${header}.${payload}.forged`;
}

describe("Apple AppTransaction verification", () => {
  it("rejects a forged Sandbox payload instead of trusting its environment claim", async () => {
    const verifier = createAppleAppTransactionVerifier({ bundleId: "com.withfina.app" });
    await expect(verifier.verify(unsignedJws("Sandbox"))).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_receipt",
    });
  });

  it("rejects unsigned Xcode and LocalTesting payloads", async () => {
    const verifier = createAppleAppTransactionVerifier({ bundleId: "com.withfina.app" });
    await expect(verifier.verify(unsignedJws("Xcode"))).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_receipt",
    });
    await expect(verifier.verify(unsignedJws("LocalTesting"))).rejects.toMatchObject({
      statusCode: 400,
      code: "invalid_receipt",
    });
  });
});
