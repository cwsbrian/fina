import { describe, it, expect } from "vitest";
import { IAP_NAMESPACE } from "./namespace.js";

describe("IAP_NAMESPACE", () => {
  it("is a v4-shaped UUID constant", () => {
    expect(IAP_NAMESPACE).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("never changes (deterministic binding depends on this)", () => {
    expect(IAP_NAMESPACE).toBe("8f3a7c2e-1b4d-4e5f-9a6b-7c8d9e0f1a2b");
  });
});
