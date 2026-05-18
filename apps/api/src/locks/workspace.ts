import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db.js";

/**
 * Wrap DB work in a Prisma interactive transaction whose FIRST SQL
 * statement is `SELECT pg_advisory_xact_lock(hashtext(workspaceId))`.
 *
 * Every amount-row writer (creates rows in Transaction, BankAccount,
 * RecurringExpense, or Budget) must use this helper. It serializes
 * writers per-workspace so that PATCH /workspaces/:id/currency can
 * count amount rows and update the workspace.currency atomically
 * without any writer slipping in.
 */
export async function withWorkspaceLock<T>(
  workspaceId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient = defaultPrisma,
): Promise<T> {
  return await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}))`;
    return await callback(tx);
  });
}
