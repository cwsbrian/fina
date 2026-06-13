import { describe, expect, it } from "vitest";
import { isUserRole, USER_ROLES } from "./user-role.js";

describe("user roles", () => {
  it("lists only global app roles", () => {
    expect(USER_ROLES).toEqual(["user", "admin"]);
  });

  it("recognizes valid roles", () => {
    expect(isUserRole("user")).toBe(true);
    expect(isUserRole("admin")).toBe(true);
    expect(isUserRole("owner")).toBe(false);
    expect(isUserRole("")).toBe(false);
  });
});
