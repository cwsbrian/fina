import type { Prisma } from "@prisma/client";

/** Canonical default category set per workspace. `icon` is an Ionicons
 *  glyph name (matches `@expo/vector-icons` Ionicons), `color` is a hex
 *  foreground. The client derives the badge bg from the same color by
 *  lowering alpha. Palette mirrors the Fina mobile design's CAT_COLORS. */
type DefaultCategory = { name: string; icon: string; color: string };

export const DEFAULT_EXPENSE_CATEGORIES: ReadonlyArray<DefaultCategory> = [
  { name: "Groceries",     icon: "cart-outline",        color: "#1f8c44" },
  { name: "Dining",        icon: "cafe-outline",        color: "#c25a25" },
  { name: "Transit",       icon: "car-outline",         color: "#5fc4a1" },
  { name: "Housing",       icon: "home-outline",        color: "#9f6420" },
  { name: "Utilities",     icon: "flash-outline",       color: "#6a4dba" },
  { name: "Health",        icon: "heart-outline",       color: "#19957f" },
  { name: "Shopping",      icon: "bag-handle-outline",  color: "#b54590" },
  { name: "Entertainment", icon: "film-outline",        color: "#c93c64" },
  { name: "Subscriptions", icon: "pricetag-outline",    color: "#3a4cd4" },
  { name: "Other",         icon: "ellipsis-horizontal", color: "#7a8a86" },
];

export const DEFAULT_INCOME_CATEGORIES: ReadonlyArray<DefaultCategory> = [
  { name: "Salary",     icon: "briefcase-outline", color: "#0f7c3a" },
  { name: "Bonus",      icon: "gift-outline",      color: "#0e8466" },
  { name: "Freelance",  icon: "laptop-outline",    color: "#2c8f7a" },
  { name: "Investment", icon: "trending-up",       color: "#1f6e9d" },
  { name: "Interest",   icon: "stats-chart",       color: "#5a8fbf" },
  { name: "Refund",     icon: "return-down-back",  color: "#9b7e2b" },
  { name: "Gift",       icon: "heart-circle",      color: "#b35c8d" },
  { name: "Transfer",   icon: "swap-horizontal",   color: "#6f7a76" },
  { name: "Other",      icon: "ellipsis-horizontal", color: "#7a8a86" },
];

/** Legacy combined list — kept for places that still need a bare name list
 *  irrespective of type (e.g., older history-lookup paths). Concatenation
 *  preserves the previous "Income" name implicitly via the new "Salary"
 *  bucket — callers needing the exact legacy string should filter on
 *  type when querying the DB instead of relying on this list. */
export const DEFAULT_CATEGORY_NAMES: ReadonlyArray<string> = [
  ...DEFAULT_EXPENSE_CATEGORIES.map((c) => c.name),
  ...DEFAULT_INCOME_CATEGORIES.map((c) => c.name),
];

export async function seedDefaultCategories(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.category.createMany({
    data: [
      ...DEFAULT_EXPENSE_CATEGORIES.map((c) => ({
        workspaceId,
        name: c.name,
        icon: c.icon,
        color: c.color,
        type: "expense" as const,
      })),
      ...DEFAULT_INCOME_CATEGORIES.map((c) => ({
        workspaceId,
        name: c.name,
        icon: c.icon,
        color: c.color,
        type: "income" as const,
      })),
    ],
    skipDuplicates: true,
  });
}
