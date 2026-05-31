import { describe, expect, it } from "vitest";
import { SOCIAL_AUTH_ERRORS, classifySocialAuthError } from "./social-errors.js";

describe("classifySocialAuthError", () => {
  it("exports the union values", () => {
    expect(SOCIAL_AUTH_ERRORS).toEqual(["oauth_failed", "oauth_cancelled", "apple_signin_unavailable"]);
  });
  it("maps Apple/user cancellation to oauth_cancelled", () => {
    expect(classifySocialAuthError({ code: "ERR_REQUEST_CANCELED" })).toBe("oauth_cancelled");
    expect(classifySocialAuthError({ message: "The operation was canceled." })).toBe("oauth_cancelled");
    expect(classifySocialAuthError({ type: "cancel" })).toBe("oauth_cancelled");
  });
  it("maps Apple-unavailable to apple_signin_unavailable", () => {
    expect(classifySocialAuthError({ message: "Sign in with Apple is not available" })).toBe("apple_signin_unavailable");
  });
  it("maps Better Auth client errors + unknown to oauth_failed", () => {
    // Call sites pass the UNWRAPPED `res.error` (top-level code), e.g.:
    expect(classifySocialAuthError({ code: "INVALID_TOKEN", message: "Invalid token", status: 401 })).toBe("oauth_failed");
    expect(classifySocialAuthError(new Error("network"))).toBe("oauth_failed");
    expect(classifySocialAuthError(undefined)).toBe("oauth_failed");
  });
  it("covers the alias/code branches + the wrapped error shape", () => {
    expect(classifySocialAuthError({ code: "ERR_CANCELED" })).toBe("oauth_cancelled");
    expect(classifySocialAuthError({ code: "ERR_APPLE_AUTHENTICATION_UNAVAILABLE" })).toBe("apple_signin_unavailable");
    // Defensive: a nested {error:{code}} shape (Better Auth version drift) still classifies.
    expect(classifySocialAuthError({ error: { code: "ERR_REQUEST_CANCELED" } })).toBe("oauth_cancelled");
  });
  it("never throws — even on hostile/non-string inputs", () => {
    expect(() => classifySocialAuthError({ message: { toString() { throw new Error("boom"); } } })).not.toThrow();
    expect(classifySocialAuthError({ message: { toString() { throw new Error("boom"); } } })).toBe("oauth_failed");
    expect(classifySocialAuthError("a string")).toBe("oauth_failed");
    expect(classifySocialAuthError(42)).toBe("oauth_failed");
    expect(classifySocialAuthError(null)).toBe("oauth_failed");
  });
});
