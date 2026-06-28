import { prisma } from "../../src/db.js";

export async function truncateAll(): Promise<void> {
  // Workspace cascade kills plaid_items, bank_accounts (Plaid), transactions,
  // categories, invites, memberships. User cascade kills sessions, accounts
  // (better-auth), and any remaining memberships. Verification has no FK to
  // User so it has to be truncated explicitly. One statement lets Postgres
  // acquire locks in a single pass, which avoids deadlocks between sequential
  // TRUNCATEs and late test-request transactions.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "workspaces",
      "users",
      "verifications",
      "webhook_events",
      "iap_deleted_bindings",
      "iap_retry_counters"
    RESTART IDENTITY CASCADE;
  `);
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
