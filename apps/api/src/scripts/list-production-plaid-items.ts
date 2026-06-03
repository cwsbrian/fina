import { pathToFileURL } from "node:url";

import { prisma } from "../db.js";
import { loadEnv } from "../env.js";

export type PlaidItemListConfig = {
  format: "table" | "json";
};

export type PlaidItemForOutput = {
  id: string;
  itemId: string;
  institutionId: string;
  institutionName: string;
  status: string;
  errorCode: string | null;
  webhookUrl: string | null;
  connectedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSyncAt: Date | null;
  workspace: { id: string; name: string };
  user: { email: string } | null;
  _count: {
    bankAccounts: number;
    transactions: number;
    webhookEvents: number;
  };
};

export type PlaidItemOutputRow = {
  id: string;
  itemId: string;
  institution: string;
  institutionId: string;
  status: string;
  errorCode: string;
  webhookUrl: string;
  workspaceId: string;
  workspace: string;
  connectedBy: string;
  connectedByUserId: string;
  bankAccounts: number;
  transactions: number;
  webhookEvents: number;
  lastSyncAt: string;
  createdAt: string;
  updatedAt: string;
};

function requireProduction(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
  key: "NODE_ENV" | "PLAID_ENV",
): void {
  if (source[key] !== "production") {
    throw new Error(`${key} must be production before listing production Plaid items`);
  }
}

export function loadPlaidItemListConfig(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): PlaidItemListConfig {
  requireProduction(source, "NODE_ENV");
  requireProduction(source, "PLAID_ENV");

  const format = (source.PLAID_LIST_FORMAT ?? "table").trim().toLowerCase();
  if (format !== "table" && format !== "json") {
    throw new Error("PLAID_LIST_FORMAT must be table or json");
  }
  return { format };
}

function iso(date: Date | null): string {
  return date?.toISOString() ?? "";
}

export function formatPlaidItemRows(items: PlaidItemForOutput[]): PlaidItemOutputRow[] {
  return items.map((item) => ({
    id: item.id,
    itemId: item.itemId,
    institution: item.institutionName,
    institutionId: item.institutionId,
    status: item.status,
    errorCode: item.errorCode ?? "",
    webhookUrl: item.webhookUrl ?? "",
    workspaceId: item.workspace.id,
    workspace: item.workspace.name,
    connectedBy: item.user?.email ?? "",
    connectedByUserId: item.connectedBy ?? "",
    bankAccounts: item._count.bankAccounts,
    transactions: item._count.transactions,
    webhookEvents: item._count.webhookEvents,
    lastSyncAt: iso(item.lastSyncAt),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  }));
}

export async function listProductionPlaidItemRows(): Promise<PlaidItemOutputRow[]> {
  const items = await prisma.plaidItem.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      itemId: true,
      institutionId: true,
      institutionName: true,
      status: true,
      errorCode: true,
      webhookUrl: true,
      connectedBy: true,
      createdAt: true,
      updatedAt: true,
      lastSyncAt: true,
      workspace: { select: { id: true, name: true } },
      user: { select: { email: true } },
      _count: {
        select: {
          bankAccounts: true,
          transactions: true,
          webhookEvents: true,
        },
      },
    },
  });

  return formatPlaidItemRows(items);
}

export async function runListProductionPlaidItems(): Promise<void> {
  const config = loadPlaidItemListConfig();
  loadEnv();
  const rows = await listProductionPlaidItemRows();

  if (config.format === "json") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(`Plaid items: ${rows.length}`);
  if (rows.length === 0) {
    console.log("No Plaid items found.");
    return;
  }
  console.table(rows);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  runListProductionPlaidItems()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
