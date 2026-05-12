import type { Prisma } from "@prisma/client";

export const DEFAULT_CATEGORIES = [
  "Groceries", "Dining", "Transit", "Housing", "Utilities",
  "Health", "Shopping", "Entertainment", "Subscriptions", "Income", "Other",
] as const;

export async function seedDefaultCategories(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.category.createMany({
    data: DEFAULT_CATEGORIES.map((name) => ({ workspaceId, name })),
    skipDuplicates: true,
  });
}
