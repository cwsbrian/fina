import { describe, expect, it } from "vitest";

import { shouldRedirectToSignIn } from "./session-guard";

describe("shouldRedirectToSignIn", () => {
  it("does not redirect while the session is still loading", () => {
    expect(shouldRedirectToSignIn({ isPending: true, hasUser: false })).toBe(false);
  });

  it("redirects once loading has finished without a valid user", () => {
    expect(shouldRedirectToSignIn({ isPending: false, hasUser: false })).toBe(true);
  });

  it("keeps authenticated users inside the app", () => {
    expect(shouldRedirectToSignIn({ isPending: false, hasUser: true })).toBe(false);
  });
});
