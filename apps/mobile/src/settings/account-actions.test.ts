import { describe, expect, it } from "vitest";

import { getAccountSettingsActions } from "./account-actions";

describe("getAccountSettingsActions", () => {
  it("shows delete account in the default account section", () => {
    expect(getAccountSettingsActions().map((action) => action.key)).toEqual([
      "edit-profile",
      "reset-password",
      "export-data",
      "delete-account",
      "sign-out",
    ]);
  });
});
