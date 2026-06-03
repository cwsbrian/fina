import { describe, expect, it } from "vitest";

import { getAccountSettingsActions } from "./account-actions";

describe("getAccountSettingsActions", () => {
  it("keeps delete account hidden from the default account section", () => {
    expect(getAccountSettingsActions().map((action) => action.key)).toEqual([
      "edit-profile",
      "reset-password",
      "export-data",
      "sign-out",
    ]);
  });
});
