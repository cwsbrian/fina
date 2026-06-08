/**
 * One-shot backfill: populate icon + color on existing seeded categories
 * that were created before those columns were filled in by the seed.
 *
 * Run from apps/api:
 *   pnpm tsx src/scripts/backfill-category-icons-colors.ts
 */
import { prisma } from "../db.js";
import {
  DEFAULT_EXPENSE_CATEGORIES,
  DEFAULT_INCOME_CATEGORIES,
} from "../categorize/seed.js";

async function main(): Promise<void> {
  let touched = 0;
  // Match by (name, type) so the "Other" name (which exists in both lists)
  // gets the right icon/color per type.
  const categorySets = [
    [DEFAULT_EXPENSE_CATEGORIES, "expense" as const],
    [DEFAULT_INCOME_CATEGORIES, "income" as const],
  ] as const;
  for (const [list, type] of categorySets) {
    for (const c of list) {
      const result = await prisma.category.updateMany({
        where: {
          name: c.name,
          type,
          OR: [{ icon: null }, { color: null }],
        },
        data: { icon: c.icon, color: c.color },
      });
      if (result.count > 0) {
        console.log(`  ${type}/${c.name}: ${result.count} row(s)`);
        touched += result.count;
      }
    }
  }
  console.log(`Done. Backfilled ${touched} category row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
