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
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_test_dummy",
  STRIPE_PRICE_LITE_MONTHLY: "price_lite_test",
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_test",
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
    // Use manual save/restore for Prisma delegates — vi.spyOn on Proxy-backed delegates
    // causes vi.restoreAllMocks() to write `undefined` back onto the delegate property,
    // breaking subsequent test files. Intercept via own-property override instead.
    let txCreateCount = 0;
    let acctCreateCount = 0;
    let acctUpsertCount = 0;
    const origTxCreate = prisma.transaction.create.bind(prisma.transaction);
    const origAcctCreate = prisma.bankAccount.create.bind(prisma.bankAccount);
    const origAcctUpsert = prisma.bankAccount.upsert.bind(prisma.bankAccount);
    prisma.transaction.create = ((...args: Parameters<typeof prisma.transaction.create>) => { txCreateCount++; return origTxCreate(...args); }) as typeof prisma.transaction.create;
    prisma.bankAccount.create = ((...args: Parameters<typeof prisma.bankAccount.create>) => { acctCreateCount++; return origAcctCreate(...args); }) as typeof prisma.bankAccount.create;
    prisma.bankAccount.upsert = ((...args: Parameters<typeof prisma.bankAccount.upsert>) => { acctUpsertCount++; return origAcctUpsert(...args); }) as typeof prisma.bankAccount.upsert;

    try {
      const { createManualTransactionService } = await import("../src/transactions/create-manual.js");
      await createManualTransactionService(
        { workspaceId: wsId, userId },
        { merchantRaw: "X", amount: 1, occurredAt: "2026-05-18" },
      );
      expect(helperSpy).toHaveBeenCalled();
      expect(txCreateCount).toBe(0);
      expect(acctCreateCount).toBe(0);
      expect(acctUpsertCount).toBe(0);
    } finally {
      prisma.transaction.create = origTxCreate as typeof prisma.transaction.create;
      prisma.bankAccount.create = origAcctCreate as typeof prisma.bankAccount.create;
      prisma.bankAccount.upsert = origAcctUpsert as typeof prisma.bankAccount.upsert;
    }
  });

  it("addRecurringService: uses helper, no top-level recurringExpense writes", async () => {
    const { wsId } = await setupEditor("ls2@t.co");
    const helperSpy = vi.spyOn(workspaceLockModule, "withWorkspaceLock");
    let recCreateCount = 0;
    let recUpsertCount = 0;
    const origRecCreate = prisma.recurringExpense.create.bind(prisma.recurringExpense);
    const origRecUpsert = prisma.recurringExpense.upsert.bind(prisma.recurringExpense);
    prisma.recurringExpense.create = ((...args: Parameters<typeof prisma.recurringExpense.create>) => { recCreateCount++; return origRecCreate(...args); }) as typeof prisma.recurringExpense.create;
    prisma.recurringExpense.upsert = ((...args: Parameters<typeof prisma.recurringExpense.upsert>) => { recUpsertCount++; return origRecUpsert(...args); }) as typeof prisma.recurringExpense.upsert;

    try {
      const { addRecurringService } = await import("../src/recurring/service.js");
      await addRecurringService(
        { workspaceId: wsId },
        { name: "Netflix", amount: 19.99, cadence: "monthly", nextOccurrenceDate: "2026-08-01" },
      );
      expect(helperSpy).toHaveBeenCalled();
      expect(recCreateCount).toBe(0);
      expect(recUpsertCount).toBe(0);
    } finally {
      prisma.recurringExpense.create = origRecCreate as typeof prisma.recurringExpense.create;
      prisma.recurringExpense.upsert = origRecUpsert as typeof prisma.recurringExpense.upsert;
    }
  });

  it("setBudgetService: uses helper, no top-level budget writes", async () => {
    const { wsId, userId } = await setupEditor("ls3@t.co");
    const cat = await prisma.category.create({ data: { workspaceId: wsId, name: "Coffee" } });
    const helperSpy = vi.spyOn(workspaceLockModule, "withWorkspaceLock");
    let bCreateCount = 0;
    let bUpsertCount = 0;
    const origBCreate = prisma.budget.create.bind(prisma.budget);
    const origBUpsert = prisma.budget.upsert.bind(prisma.budget);
    prisma.budget.create = ((...args: Parameters<typeof prisma.budget.create>) => { bCreateCount++; return origBCreate(...args); }) as typeof prisma.budget.create;
    prisma.budget.upsert = ((...args: Parameters<typeof prisma.budget.upsert>) => { bUpsertCount++; return origBUpsert(...args); }) as typeof prisma.budget.upsert;

    try {
      const { setBudgetService } = await import("../src/budgets/service.js");
      await setBudgetService(
        { workspaceId: wsId, userId },
        { categoryId: cat.id, amount: 100, period: "this_month" },
      );
      expect(helperSpy).toHaveBeenCalled();
      expect(bCreateCount).toBe(0);
      expect(bUpsertCount).toBe(0);
    } finally {
      prisma.budget.create = origBCreate as typeof prisma.budget.create;
      prisma.budget.upsert = origBUpsert as typeof prisma.budget.upsert;
    }
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
