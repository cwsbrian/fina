import { prisma } from "../../src/db.js";

export async function truncateAll(): Promise<void> {
  // Workspace cascade kills plaid_items, bank_accounts (Plaid), transactions,
  // categories, invites, memberships. User cascade kills sessions, accounts
  // (better-auth), and any remaining memberships. Verification has no FK to
  // User so it has to be truncated explicitly. Order: workspaces first (so
  // workspace-scoped rows are removed cleanly), then users.
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "workspaces" RESTART IDENTITY CASCADE;`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "users" RESTART IDENTITY CASCADE;`);
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "verifications" RESTART IDENTITY CASCADE;`);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
