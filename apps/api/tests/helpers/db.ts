import { prisma } from "../../src/db.js";

export async function truncateAll(): Promise<void> {
  // Order: leaf → root.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "memberships", "workspaces", "verifications", "sessions",
                   "accounts", "users"
    RESTART IDENTITY CASCADE;
  `);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
