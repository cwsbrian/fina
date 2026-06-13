import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/db.js";
import { setUserRoleByEmail } from "../src/scripts/set-user-role.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("setUserRoleByEmail", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("promotes an existing user by normalized email", async () => {
    await prisma.user.create({
      data: { id: "admin-1", email: "cwsbrian@gmail.com", name: "Brian" },
    });

    const updated = await setUserRoleByEmail("CwsBrian@Gmail.Com", "admin");

    expect(updated).toEqual({
      id: "admin-1",
      email: "cwsbrian@gmail.com",
      role: "admin",
    });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: "admin-1" } }),
    ).resolves.toMatchObject({ role: "admin" });
  });

  it("demotes an existing admin", async () => {
    await prisma.user.create({
      data: { id: "admin-2", email: "admin2@example.com", name: "Admin", role: "admin" },
    });

    const updated = await setUserRoleByEmail("admin2@example.com", "user");

    expect(updated.role).toBe("user");
  });

  it("fails when the user does not exist", async () => {
    await expect(setUserRoleByEmail("missing@example.com", "admin")).rejects.toThrow(
      "User not found: missing@example.com",
    );
  });

  it("fails when role is invalid at runtime", async () => {
    await prisma.user.create({
      data: { id: "admin-3", email: "admin3@example.com", name: "Admin" },
    });

    await expect(setUserRoleByEmail("admin3@example.com", "owner")).rejects.toThrow(
      "Invalid role: owner",
    );
  });
});
