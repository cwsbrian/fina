import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
import { buildApp } from "../src/server.js";
import * as workspaceLockModule from "../src/locks/workspace.js";

const env = {
  NODE_ENV: "test" as const, PORT: 0,
  DATABASE_URL: process.env.DATABASE_URL!,
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "http://localhost:0",
  EMAIL_FROM: "test@fina.app",
  WEB_APP_URL: "http://localhost:3000",
  PLAID_CLIENT_ID: "test_client_id",
  PLAID_SECRET: "test_secret",
  PLAID_ENV: "sandbox" as const,
  ENCRYPTION_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  GEMINI_API_KEY: "test_gemini_key",
};

let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(env); await app.ready(); });
afterAll(async () => { await app.close(); await disconnect(); });
beforeEach(async () => { await truncateAll(); });
afterEach(() => { vi.restoreAllMocks(); });

async function setupEditor(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

describe("withWorkspaceLock spy — writers go through the helper, NOT top-level prisma", () => {
  it("createManualTransactionService: uses helper, no top-level transaction/bankAccount writes", async () => {
    const { wsId, userId } = await setupEditor("ls1@t.co");
    const helperSpy = vi.spyOn(workspaceLockModule, "withWorkspaceLock");
    const txCreate = vi.spyOn(prisma.transaction, "create");
    const acctCreate = vi.spyOn(prisma.bankAccount, "create");
    const acctUpsert = vi.spyOn(prisma.bankAccount, "upsert");

    const { createManualTransactionService } = await import("../src/transactions/create-manual.js");
    await createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1, occurredAt: "2026-05-18" },
    );
    expect(helperSpy).toHaveBeenCalled();
    expect(txCreate).not.toHaveBeenCalled();
    expect(acctCreate).not.toHaveBeenCalled();
    expect(acctUpsert).not.toHaveBeenCalled();
  });

  it("addRecurringService: uses helper, no top-level recurringExpense writes", async () => {
    const { wsId } = await setupEditor("ls2@t.co");
    const helperSpy = vi.spyOn(workspaceLockModule, "withWorkspaceLock");
    const recCreate = vi.spyOn(prisma.recurringExpense, "create");
    const recUpsert = vi.spyOn(prisma.recurringExpense, "upsert");

    const { addRecurringService } = await import("../src/recurring/service.js");
    await addRecurringService(
      { workspaceId: wsId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-08-01" },
    );
    expect(helperSpy).toHaveBeenCalled();
    expect(recCreate).not.toHaveBeenCalled();
    expect(recUpsert).not.toHaveBeenCalled();
  });

  it("setBudgetService: uses helper, no top-level budget writes", async () => {
    const { wsId, userId } = await setupEditor("ls3@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
    const helperSpy = vi.spyOn(workspaceLockModule, "withWorkspaceLock");
    const bCreate = vi.spyOn(prisma.budget, "create");
    const bUpsert = vi.spyOn(prisma.budget, "upsert");

    const { setBudgetService } = await import("../src/budgets/service.js");
    await setBudgetService(
      { workspaceId: wsId, userId },
      { categoryId: cat.id, amount: 100, period: "this_month" },
    );
    expect(helperSpy).toHaveBeenCalled();
    expect(bCreate).not.toHaveBeenCalled();
    expect(bUpsert).not.toHaveBeenCalled();
  });
});

describe("integration race — writers block while holder owns the lock", () => {
  it("createManualTransactionService blocks on held lock, then sees post-PATCH currency", async () => {
    const { wsId, userId } = await setupEditor("rc1@t.co");
    // Ensure workspace is visible outside the test's implicit transaction
    await prisma.workspace.findFirstOrThrow({ where: { id: wsId } });

    const holder = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } },
    });
    await holder.$connect();
    await holder.$executeRaw`BEGIN`;
    await holder.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wsId}))`;

    const { createManualTransactionService } = await import("../src/transactions/create-manual.js");
    const candidate = createManualTransactionService(
      { workspaceId: wsId, userId },
      { merchantRaw: "X", amount: 1, occurredAt: "2026-05-18" },
    );

    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    expect(winner).toBe("timeout");

    await holder.$executeRaw`UPDATE workspaces SET currency = 'USD' WHERE id = ${wsId}`;
    await holder.$executeRaw`COMMIT`;
    await holder.$disconnect();

    const result = await candidate;
    expect(result.transaction.currency).toBe("USD");
  });

  it("addRecurringService blocks on held lock, then sees post-PATCH currency", async () => {
    const { wsId } = await setupEditor("rc2@t.co");
    await prisma.workspace.findFirstOrThrow({ where: { id: wsId } });

    const holder = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } },
    });
    await holder.$connect();
    await holder.$executeRaw`BEGIN`;
    await holder.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wsId}))`;

    const { addRecurringService } = await import("../src/recurring/service.js");
    const candidate = addRecurringService(
      { workspaceId: wsId },
      { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-08-01" },
    );
    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    expect(winner).toBe("timeout");
    await holder.$executeRaw`UPDATE workspaces SET currency = 'USD' WHERE id = ${wsId}`;
    await holder.$executeRaw`COMMIT`;
    await holder.$disconnect();
    const result = await candidate;
    expect(result.recurring.currency).toBe("USD");
  });

  it("setBudgetService blocks on held lock", async () => {
    const { wsId, userId } = await setupEditor("rc3@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
    await prisma.workspace.findFirstOrThrow({ where: { id: wsId } });

    const holder = new PrismaClient({
      datasources: { db: { url: process.env.DATABASE_URL! } },
    });
    await holder.$connect();
    await holder.$executeRaw`BEGIN`;
    await holder.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${wsId}))`;

    const { setBudgetService } = await import("../src/budgets/service.js");
    const candidate = setBudgetService(
      { workspaceId: wsId, userId },
      { categoryId: cat.id, amount: 100, period: "this_month" },
    );
    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 300)),
    ]);
    expect(winner).toBe("timeout");
    await holder.$executeRaw`COMMIT`;
    await holder.$disconnect();
    const result = await candidate;
    expect(result).toBeDefined();
  });
});
