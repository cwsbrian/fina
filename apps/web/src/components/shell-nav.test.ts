import { describe, expect, it } from "vitest";
import { navItemsForRole } from "./shell-nav";

describe("navItemsForRole", () => {
  it("hides Admin for default users", () => {
    expect(navItemsForRole("user").map((item) => item.label)).not.toContain("Admin");
    expect(navItemsForRole(null).map((item) => item.label)).not.toContain("Admin");
  });

  it("shows Admin for global admins", () => {
    expect(navItemsForRole("admin")).toContainEqual({
      id: "admin",
      label: "Admin",
      path: "/admin",
    });
  });
});
