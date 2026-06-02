import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db.js";

export async function withUserLock<T>(
  userId: string,
  callback: (tx: Prisma.TransactionClient) => Promise<T>,
  client: PrismaClient = defaultPrisma,
): Promise<T> {
  return await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user:${userId}`}))`;
    return await callback(tx);
  });
}
