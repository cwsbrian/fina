import { describe, expect, it, vi } from "vitest";

vi.mock("./client", () => ({ apiFetch: vi.fn() }));

import { isUnsyncedIAPPurchaseError } from "./billing";

describe("billing api helpers", () => {
  it("recognizes the local IAP unsynced purchase error", () => {
    expect(
      isUnsyncedIAPPurchaseError(
        new Error("Purchase was found, but the server did not sync an active subscription."),
      ),
    ).toBe(true);
    expect(isUnsyncedIAPPurchaseError(new Error("other"))).toBe(false);
  });
});
