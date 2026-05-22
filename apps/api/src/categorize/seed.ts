import type { Prisma } from "@prisma/client";

/** Canonical default category set per workspace. `icon` is an Ionicons
 *  glyph name (matches `@expo/vector-icons` Ionicons), `color` is a hex
 *  foreground. The client derives the badge bg from the same color by
 *  lowering alpha. Palette mirrors the Fina mobile design's CAT_COLORS. */
export const DEFAULT_CATEGORIES: ReadonlyArray<{
  name: string;
  icon: string;
  color: string;
}> = [
  { name: "Groceries",     icon: "cart-outline",       color: "#1f8c44" },
  { name: "Dining",        icon: "cafe-outline",       color: "#c25a25" },
  { name: "Transit",       icon: "car-outline",        color: "#5fc4a1" },
  { name: "Housing",       icon: "home-outline",       color: "#9f6420" },
  { name: "Utilities",     icon: "flash-outline",      color: "#6a4dba" },
  { name: "Health",        icon: "heart-outline",      color: "#19957f" },
  { name: "Shopping",      icon: "bag-handle-outline", color: "#b54590" },
  { name: "Entertainment", icon: "film-outline",       color: "#c93c64" },
  { name: "Subscriptions", icon: "pricetag-outline",   color: "#3a4cd4" },
  { name: "Income",        icon: "trending-up",        color: "#0f7c3a" },
  { name: "Other",         icon: "ellipsis-horizontal", color: "#7a8a86" },
];

/** Names only — preserved for places that still need the bare list. */
export const DEFAULT_CATEGORY_NAMES: ReadonlyArray<string> = DEFAULT_CATEGORIES.map(
  (c) => c.name,
);

export async function seedDefaultCategories(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.category.createMany({
    data: DEFAULT_CATEGORIES.map((c) => ({
      workspaceId,
      name: c.name,
      icon: c.icon,
      color: c.color,
    })),
    skipDuplicates: true,
  });
}
