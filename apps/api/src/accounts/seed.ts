import type { Prisma } from "@prisma/client";

/** Default manual accounts that show up in a fresh workspace. Mirrors
 *  the everyday "where did this money come from / go to" buckets users
 *  expect to pick from right away. Type maps to the Plaid type column
 *  so the existing manual/plaid split logic continues to work. */
export const DEFAULT_ACCOUNTS: ReadonlyArray<{
  name: string;
  type: string;
}> = [
  { name: "Cash",     type: "depository" },
  { name: "Debit",    type: "depository" },
  { name: "Checking", type: "depository" },
  { name: "Savings",  type: "depository" },
  { name: "Credit",   type: "credit" },
];

export async function seedDefaultAccounts(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  currency: string,
): Promise<void> {
  await tx.bankAccount.createMany({
    data: DEFAULT_ACCOUNTS.map((a) => ({
      workspaceId,
      name: a.name,
      type: a.type,
      currency,
      status: "active",
    })),
    skipDuplicates: true,
  });
}
