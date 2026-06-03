import { describe, expect, it } from "vitest";

import { isBackendUnavailableError } from "./backend-status";

describe("isBackendUnavailableError", () => {
  it("recognizes the shared network_unreachable ApiError", () => {
    expect(
      isBackendUnavailableError({
        status: 0,
        code: "network_unreachable",
        message: "Backend is unreachable",
      }),
    ).toBe(true);
  });

  it("does not classify auth failures as maintenance", () => {
    expect(isBackendUnavailableError({ status: 401, code: "unauthenticated" })).toBe(false);
  });
});
