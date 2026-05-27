import { describe, it, expect } from "vitest";
import { deriveAppleToken, deriveGoogleToken, hashBindingToken } from "../../src/iap/binding.js";

describe("deterministic IAP binding", () => {
  it("deriveAppleToken is uuidv5(userId, IAP_NAMESPACE)", () => {
    const a = deriveAppleToken("user-1");
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveAppleToken("user-1")).toBe(a);
  });
  it("different userIds produce different tokens", () => {
    expect(deriveAppleToken("user-1")).not.toBe(deriveAppleToken("user-2"));
  });
  it("deriveGoogleToken is sha256(userId) hex, 64 chars", () => {
    const g = deriveGoogleToken("user-1");
    expect(g).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveGoogleToken("user-1")).toBe(g);
  });
  it("hashBindingToken is sha256 hex", () => {
    expect(hashBindingToken("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});
