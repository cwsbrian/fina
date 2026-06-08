import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

import type { Env } from "../env.js";
import { loadEnv } from "../env.js";
import { prisma } from "../db.js";
import { decrypt } from "../crypto/aes-gcm.js";
import { startTrialAndBootstrapWorkspace } from "../workspaces/bootstrap.js";

export const CONFIRM_PROD_RESET_TOKEN = "WIPE_WITHFINA_PRODUCTION";

export const PRODUCTION_RESET_TABLES = [
  "webhook_events",
  "plaid_webhook_events",
  "iap_deleted_bindings",
  "iap_retry_counters",
  "verifications",
  "workspaces",
  "users",
] as const;

export type ResetConfig = {
  testerEmail: string;
  testerPassword: string;
};

type TesterTransactionSeed = {
  daysAgo: number;
  merchant: string;
  amount: string;
  account: string;
  category: string;
  categoryType: "expense" | "income";
  needsConfirmation?: boolean;
  pending?: boolean;
  note?: string;
};

const TESTER_TRANSACTION_SEEDS: readonly TesterTransactionSeed[] = [
  {
    daysAgo: 0,
    merchant: "Whole Foods Market",
    amount: "84.32",
    account: "Debit",
    category: "Groceries",
    categoryType: "expense",
    needsConfirmation: true,
  },
  { daysAgo: 1, merchant: "Uber", amount: "16.45", account: "Credit", category: "Transit", categoryType: "expense" },
  {
    daysAgo: 2,
    merchant: "Netflix",
    amount: "18.99",
    account: "Credit",
    category: "Subscriptions",
    categoryType: "expense",
  },
  {
    daysAgo: 3,
    merchant: "Local Coffee",
    amount: "6.40",
    account: "Debit",
    category: "Dining",
    categoryType: "expense",
    needsConfirmation: true,
  },
  { daysAgo: 4, merchant: "BC Hydro", amount: "72.10", account: "Checking", category: "Utilities", categoryType: "expense" },
  {
    daysAgo: 5,
    merchant: "Payroll Deposit",
    amount: "-2450.00",
    account: "Checking",
    category: "Salary",
    categoryType: "income",
  },
  {
    daysAgo: 7,
    merchant: "Shoppers Drug Mart",
    amount: "38.27",
    account: "Debit",
    category: "Health",
    categoryType: "expense",
  },
  {
    daysAgo: 9,
    merchant: "Amazon",
    amount: "129.88",
    account: "Credit",
    category: "Shopping",
    categoryType: "expense",
    needsConfirmation: true,
  },
  {
    daysAgo: 11,
    merchant: "Cineplex",
    amount: "31.50",
    account: "Credit",
    category: "Entertainment",
    categoryType: "expense",
  },
  {
    daysAgo: 14,
    merchant: "Save-On-Foods",
    amount: "112.64",
    account: "Debit",
    category: "Groceries",
    categoryType: "expense",
  },
  {
    daysAgo: 16,
    merchant: "Spotify",
    amount: "10.99",
    account: "Credit",
    category: "Subscriptions",
    categoryType: "expense",
  },
  {
    daysAgo: 18,
    merchant: "Restaurant Nuba",
    amount: "48.20",
    account: "Credit",
    category: "Dining",
    categoryType: "expense",
  },
  { daysAgo: 21, merchant: "TransLink", amount: "25.00", account: "Debit", category: "Transit", categoryType: "expense" },
  {
    daysAgo: 24,
    merchant: "Freelance Payment",
    amount: "-600.00",
    account: "Checking",
    category: "Freelance",
    categoryType: "income",
  },
  { daysAgo: 28, merchant: "Phone Bill", amount: "64.00", account: "Credit", category: "Utilities", categoryType: "expense" },
  {
    daysAgo: 34,
    merchant: "Grocery Refund",
    amount: "-22.15",
    account: "Debit",
    category: "Refund",
    categoryType: "income",
    note: "Sample refund",
  },
];

function requireValue(source: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string): string {
  const value = source[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function loadResetConfig(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ResetConfig {
  if (source.NODE_ENV !== "production") {
    throw new Error("NODE_ENV must be production for this destructive reset");
  }
  if (source.PLAID_ENV !== "production") {
    throw new Error("PLAID_ENV must be production before removing production Plaid items");
  }
  if (source.CONFIRM_PROD_RESET !== CONFIRM_PROD_RESET_TOKEN) {
    throw new Error(
      `CONFIRM_PROD_RESET must be exactly ${CONFIRM_PROD_RESET_TOKEN}`,
    );
  }

  const testerEmail = requireValue(source, "TESTER_EMAIL").toLowerCase();
  const testerPassword = requireValue(source, "TESTER_PASSWORD");
  if (!testerEmail.includes("@")) {
    throw new Error("TESTER_EMAIL must be an email address");
  }
  if (testerPassword.length < 12) {
    throw new Error("TESTER_PASSWORD must be at least 12 characters");
  }
  return { testerEmail, testerPassword };
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function buildProductionTruncateSql(): string {
  const tables = PRODUCTION_RESET_TABLES.map(quoteIdent).join(", ");
  return `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE;`;
}

async function removeProductionPlaidItems(env: Env): Promise<number> {
  const items = await prisma.plaidItem.findMany({
    where: { status: { not: "disconnected" } },
    select: { id: true, workspaceId: true, itemId: true },
    orderBy: { createdAt: "asc" },
  });

  for (const item of items) {
    const { accessToken } = await readScriptAccessToken(env, item.workspaceId, item.id);
    try {
      await scriptPlaidClient(env).itemRemove({ access_token: accessToken });
      console.log(`Removed Plaid item ${item.itemId}`);
    } catch (e) {
      if (isPlaidErrorCode(e, "ITEM_NOT_FOUND")) {
        console.log(`Plaid item ${item.itemId} was already removed`);
        continue;
      }
      console.error("Plaid item remove failed", {
        plaidItemId: item.id,
        itemId: item.itemId,
        error: sanitizePlaidError(e),
      });
      throw new Error(
        `Aborting before DB wipe because Plaid item ${item.itemId} could not be removed`,
      );
    }
  }

  return items.length;
}

async function wipeProductionDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(buildProductionTruncateSql());
}

function scriptPlaidClient(env: Env): PlaidApi {
  return new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env.PLAID_ENV]!,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": env.PLAID_CLIENT_ID,
          "PLAID-SECRET": env.PLAID_SECRET,
          "Plaid-Version": "2020-09-14",
        },
      },
    }),
  );
}

function sanitizePlaidError(e: unknown): {
  error_code: string | null;
  error_type: string | null;
  error_message: string | null;
  request_id: string | null;
  http_status: number | null;
} {
  const any = e as Record<string, unknown>;
  const data = (any?.response as Record<string, unknown> | undefined)?.data as
    | Record<string, unknown>
    | undefined;
  const status = (any?.response as Record<string, unknown> | undefined)?.status as number | undefined;
  return {
    error_code: (data?.error_code as string) ?? null,
    error_type: (data?.error_type as string) ?? null,
    error_message: (data?.error_message as string) ?? null,
    request_id: (data?.request_id as string) ?? null,
    http_status: status ?? null,
  };
}

function isPlaidErrorCode(e: unknown, code: string): boolean {
  return sanitizePlaidError(e).error_code === code;
}

async function readScriptAccessToken(
  env: Env,
  workspaceId: string,
  plaidItemId: string,
): Promise<{ accessToken: string; itemRow: { id: string; itemId: string } }> {
  const row = await prisma.plaidItem.findUnique({
    where: { id: plaidItemId },
    select: {
      id: true,
      workspaceId: true,
      itemId: true,
      accessTokenCiphertext: true,
      accessTokenIv: true,
    },
  });
  if (!row || row.workspaceId !== workspaceId) {
    throw new Error(`Plaid item ${plaidItemId} not found in workspace ${workspaceId}`);
  }
  return {
    accessToken: decrypt(env, row.accessTokenCiphertext, row.accessTokenIv, workspaceId),
    itemRow: { id: row.id, itemId: row.itemId },
  };
}

function daysAgoAtNoon(daysAgo: number): Date {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

function normalizeMerchant(merchant: string): string {
  return merchant.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function seedTesterTransactions(workspaceId: string): Promise<number> {
  const [accounts, categories] = await Promise.all([
    prisma.bankAccount.findMany({
      where: { workspaceId, status: "active", plaidItemId: null },
      select: { id: true, name: true },
    }),
    prisma.category.findMany({
      where: { workspaceId, archivedAt: null },
      select: { id: true, name: true, type: true },
    }),
  ]);

  const accountByName = new Map(accounts.map((account) => [account.name.toLowerCase(), account]));
  const categoryByNameAndType = new Map(
    categories.map((category) => [`${category.type}:${category.name.toLowerCase()}`, category]),
  );
  const fallbackAccount = accountByName.get("checking") ?? accounts[0];
  if (!fallbackAccount) {
    throw new Error("Cannot seed tester transactions without a manual account");
  }

  for (const seed of TESTER_TRANSACTION_SEEDS) {
    const account = accountByName.get(seed.account.toLowerCase()) ?? fallbackAccount;
    const category = categoryByNameAndType.get(`${seed.categoryType}:${seed.category.toLowerCase()}`);
    if (!category) {
      throw new Error(`Cannot seed tester transaction; missing category ${seed.categoryType}:${seed.category}`);
    }
    await prisma.transaction.create({
      data: {
        workspaceId,
        accountId: account.id,
        amount: seed.amount,
        merchantRaw: seed.merchant,
        merchantNormalized: normalizeMerchant(seed.merchant),
        occurredAt: daysAgoAtNoon(seed.daysAgo),
        postedAt: seed.pending ? null : daysAgoAtNoon(seed.daysAgo),
        pending: seed.pending ?? false,
        source: "manual",
        rawData: { seededBy: "prod-reset-internal-test" },
        ...(seed.note !== undefined ? { note: seed.note } : {}),
        allocations: {
          create: {
            categoryId: category.id,
            amount: seed.amount,
            source: seed.needsConfirmation ? "ai" : "manual",
            needsConfirmation: seed.needsConfirmation ?? false,
          },
        },
      },
    });
  }

  return TESTER_TRANSACTION_SEEDS.length;
}

export async function createTesterUser(config: ResetConfig): Promise<{ userId: string; workspaceId: string }> {
  const userId = randomUUID();
  const password = await hashPassword(config.testerPassword);
  const now = new Date();

  await prisma.user.create({
    data: {
      id: userId,
      email: config.testerEmail,
      emailVerified: true,
      name: "Tester",
      createdAt: now,
      updatedAt: now,
      accounts: {
        create: {
          id: randomUUID(),
          accountId: config.testerEmail,
          providerId: "credential",
          password,
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  });

  const bootstrapped = await startTrialAndBootstrapWorkspace({ userId });
  await seedTesterTransactions(bootstrapped.workspace.id);
  return { userId, workspaceId: bootstrapped.workspace.id };
}

export async function runResetProductionForInternalTest(): Promise<void> {
  const env = loadEnv();
  const config = loadResetConfig();

  console.log("Starting production reset for internal testing");
  console.log(`Tester email: ${config.testerEmail}`);
  console.log("Removing production Plaid items before wiping DB...");
  const removedPlaidItems = await removeProductionPlaidItems(env);
  console.log(`Plaid items processed: ${removedPlaidItems}`);

  console.log("Wiping production database...");
  await wipeProductionDatabase();

  console.log("Creating tester user...");
  const created = await createTesterUser(config);
  console.log("Tester user created", {
    email: config.testerEmail,
    userId: created.userId,
    workspaceId: created.workspaceId,
  });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  runResetProductionForInternalTest()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
