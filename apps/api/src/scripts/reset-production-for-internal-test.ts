import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";

import type { Env } from "../env.js";
import { loadEnv } from "../env.js";
import { prisma } from "../db.js";
import { plaidClient, isPlaidErrorCode, sanitizePlaidError } from "../plaid/client.js";
import { readAccessToken } from "../plaid/items.js";
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
    const { accessToken } = await readAccessToken(env, item.workspaceId, item.id);
    try {
      await plaidClient(env).itemRemove({ access_token: accessToken });
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
