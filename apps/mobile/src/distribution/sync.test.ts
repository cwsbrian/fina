import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getSignedAppleAppTransaction: vi.fn(),
}));

vi.mock("../api/client", () => ({ apiFetch: mocks.apiFetch }));
vi.mock("../iap/native-subscription-store", () => ({
  getSignedAppleAppTransaction: mocks.getSignedAppleAppTransaction,
}));

import { syncAppleSignupEnvironment } from "./sync";

describe("syncAppleSignupEnvironment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("posts the native Apple proof after login", async () => {
    const result = { signupEnvironment: "TEST" };
    mocks.getSignedAppleAppTransaction.mockResolvedValue("signed.app.transaction");
    mocks.apiFetch.mockResolvedValue(result);

    await expect(syncAppleSignupEnvironment()).resolves.toBe(result);
    expect(mocks.apiFetch).toHaveBeenCalledWith("/me/distribution", {
      method: "POST",
      body: JSON.stringify({ signedAppTransaction: "signed.app.transaction" }),
    });
  });

  it("does nothing in Expo Go or when the native proof is unavailable", async () => {
    mocks.getSignedAppleAppTransaction.mockResolvedValue(null);

    await expect(syncAppleSignupEnvironment()).resolves.toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});
