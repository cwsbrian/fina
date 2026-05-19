import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { prisma } from "../src/db.js";
import { buildApp } from "../src/server.js";
import { signUpAndGetCookie, getOwnerWorkspaceId } from "./helpers/auth.js";
import { truncateAll, disconnect } from "./helpers/db.js";
// Static imports at top — cold-module loading must NOT happen inside the race
// test where it could be misread as "blocked by lock". When Tasks 4/5 add their
// race tests, append the corresponding import here (`editTransactionService`,
// `removeTransactionService`) so the import-load cost is paid once at file
// load, not during the timed lock test.
import { applyManualCategorize } from "../src/categorize/manual-categorize.js";
import { createManualTransactionService } from "../src/transactions/create-manual.js";

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

type Holder = { release: () => void; done: Promise<unknown> };

async function holdLock(workspaceId: string): Promise<Holder> {
  const client = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  await client.$connect();
  let resolveBarrier!: () => void;
  const barrier = new Promise<void>((r) => { resolveBarrier = r; });
  let resolveAcquired!: () => void;
  const acquired = new Promise<void>((r) => { resolveAcquired = r; });

  const done = client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`;
    resolveAcquired();
    await barrier;
  }).finally(() => client.$disconnect());

  await acquired;
  return { release: () => resolveBarrier(), done };
}

async function setupEditor(email: string): Promise<{ cookie: string; wsId: string; userId: string }> {
  const u = await signUpAndGetCookie(app, { email });
  const wsId = await getOwnerWorkspaceId(u.userId);
  return { cookie: u.cookie, wsId, userId: u.userId };
}

async function seedManualTx(wsId: string, opts?: { merchantRaw?: string }): Promise<string> {
  const acct = await prisma.bankAccount.create({
    data: { workspaceId: wsId, name: "Cash", type: "depository", status: "active" },
  });
  const tx = await prisma.transaction.create({
    data: {
      workspaceId: wsId,
      accountId: acct.id,
      plaidTransactionId: null,
      amount: "10.00",
      merchantRaw: opts?.merchantRaw ?? "Costco",
      merchantNormalized: "costco",
      occurredAt: new Date("2026-05-19T12:00:00Z"),
      pending: false,
      source: "manual",
      rawData: {},
    },
  });
  return tx.id;
}

describe("transactions race tests — lock acquisition proofs", () => {
  it("Test C: applyManualCategorize blocks while holder owns the workspace advisory lock", async () => {
    const { wsId } = await setupEditor("race-c@t.co");
    const txIdBaseline = await seedManualTx(wsId);
    // "Groceries" is seeded at workspace creation — no need to create it.

    // Unlocked baseline: the same call without a holder must complete quickly
    // (well under the locked-threshold). Proves the timeout-vs-finish race in
    // the locked phase isn't just measuring DB warmup cost.
    const tBaseline = Date.now();
    await applyManualCategorize({ workspaceId: wsId, txId: txIdBaseline, categoryName: "Groceries" });
    const baselineMs = Date.now() - tBaseline;
    expect(baselineMs).toBeLessThan(800);

    // Now run the locked phase with a fresh seed so the call has actual work to do.
    const txIdLocked = await seedManualTx(wsId, { merchantRaw: "Walmart" });
    const holder = await holdLock(wsId);
    const candidate = applyManualCategorize({ workspaceId: wsId, txId: txIdLocked, categoryName: "Groceries" });

    const winner = await Promise.race([
      candidate.then(() => "candidate"),
      new Promise<string>((r) => setTimeout(() => r("timeout"), 800)),
    ]);
    expect(winner).toBe("timeout");

    holder.release();
    await holder.done;
    const result = await candidate;
    expect(result.tx.categorizationSource).toBe("manual");
  });
});
