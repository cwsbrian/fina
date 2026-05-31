import { describe, expect, it } from "vitest";
import { createAuth } from "../src/auth.js";
import { testEnv } from "./helpers/test-env.js";

describe("createAuth social providers", () => {
  it("registers google + apple when creds are set, and enables safe account linking", () => {
    const auth = createAuth(
      testEnv({
        GOOGLE_CLIENT_ID: "gid",
        GOOGLE_CLIENT_SECRET: "gsecret",
        APPLE_CLIENT_ID: "com.withfina.web",
        APPLE_CLIENT_SECRET: "asecret",
      }),
    );
    const sp = auth.options.socialProviders as Record<string, { clientId: string; appBundleIdentifier?: string }>;
    expect(Object.keys(sp).sort()).toEqual(["apple", "google"]);
    expect(sp.apple.appBundleIdentifier).toBe("com.withfina.app");
    // Loose-cast: better-auth's Auth.options is the literal we passed, which
    // doesn't carry a `trustedProviders` key (we deliberately omit it), so a
    // typed `?.trustedProviders` access wouldn't compile.
    const linking = (
      auth.options.account as
        | { accountLinking?: { enabled?: boolean; trustedProviders?: unknown } }
        | undefined
    )?.accountLinking;
    expect(linking?.enabled).toBe(true);
    expect(linking?.trustedProviders).toBeUndefined();
  });

  it("registers neither provider when creds are unset", () => {
    const auth = createAuth(testEnv());
    expect(Object.keys((auth.options.socialProviders ?? {}) as object)).toEqual([]);
  });
});
