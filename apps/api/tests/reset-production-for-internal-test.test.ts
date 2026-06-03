import { describe, expect, it, beforeEach, afterAll } from "vitest";
import { verifyPassword } from "better-auth/crypto";

import { prisma } from "../src/db.js";
import {
  CONFIRM_PROD_RESET_TOKEN,
  PRODUCTION_RESET_TABLES,
  buildProductionTruncateSql,
  createTesterUser,
  loadResetConfig,
} from "../src/scripts/reset-production-for-internal-test.js";
import { truncateAll, disconnect } from "./helpers/db.js";

describe("reset-production-for-internal-test guards", () => {
  const validEnv = {
    NODE_ENV: "production",
    PLAID_ENV: "production",
    CONFIRM_PROD_RESET: CONFIRM_PROD_RESET_TOKEN,
    TESTER_EMAIL: "tester@test.com",
    TESTER_PASSWORD: "test-password-1234567890",
  };

  it("requires the explicit destructive confirmation token", () => {
    expect(() =>
      loadResetConfig({ ...validEnv, CONFIRM_PROD_RESET: "yes" }),
    ).toThrow(/CONFIRM_PROD_RESET/);
  });

  it("requires production runtime and Plaid production", () => {
    expect(() => loadResetConfig({ ...validEnv, NODE_ENV: "development" })).toThrow(/NODE_ENV/);
    expect(() => loadResetConfig({ ...validEnv, PLAID_ENV: "sandbox" })).toThrow(/PLAID_ENV/);
  });

  it("reads tester credentials from production env", () => {
    expect(loadResetConfig(validEnv)).toEqual({
      testerEmail: "tester@test.com",
      testerPassword: "test-password-1234567890",
    });
  });

  it("builds one cascade truncate statement for production data tables", () => {
    const sql = buildProductionTruncateSql();
    expect(sql).toContain('"users"');
    expect(sql).toContain('"workspaces"');
    expect(sql).toContain('"plaid_webhook_events"');
    expect(sql).toContain("RESTART IDENTITY CASCADE");
    expect(PRODUCTION_RESET_TABLES).not.toContain("_prisma_migrations");
  });
});

describe("createTesterUser", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await disconnect();
  });

  it("creates a verified credential user with a bootstrapped workspace", async () => {
    const password = "test-password-1234567890";
    const created = await createTesterUser({
      testerEmail: "tester@test.com",
      testerPassword: password,
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: created.userId },
      include: { accounts: true, memberships: true },
    });
    expect(user.email).toBe("tester@test.com");
    expect(user.emailVerified).toBe(true);
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships[0]?.workspaceId).toBe(created.workspaceId);

    const account = user.accounts.find((row) => row.providerId === "credential");
    expect(account?.accountId).toBe("tester@test.com");
    expect(account?.password).toBeTruthy();
    await expect(
      verifyPassword({ hash: account!.password!, password }),
    ).resolves.toBe(true);

    await expect(
      prisma.category.count({ where: { workspaceId: created.workspaceId } }),
    ).resolves.toBeGreaterThan(0);
    await expect(
      prisma.bankAccount.count({ where: { workspaceId: created.workspaceId } }),
    ).resolves.toBeGreaterThan(0);
  });
});
