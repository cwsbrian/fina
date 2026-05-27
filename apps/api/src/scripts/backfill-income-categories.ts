/**
 * One-shot backfill: insert the 9 default Income categories into every
 * existing workspace. Skips any (workspaceId, name) pair that already
 * exists, so re-running is safe.
 *
 * Run from apps/api:
 *   pnpm tsx src/scripts/backfill-income-categories.ts
 */
import { prisma } from "../db.js";
import { DEFAULT_INCOME_CATEGORIES } from "../categorize/seed.js";

async function main(): Promise<void> {
  const workspaces = await prisma.workspace.findMany({ select: { id: true, name: true } });
  console.log(`Backfilling ${DEFAULT_INCOME_CATEGORIES.length} income categories into ${workspaces.length} workspace(s)...`);

  let inserted = 0;
  for (const w of workspaces) {
    const existing = await prisma.category.findMany({
      where: { workspaceId: w.id, type: "income" },
      select: { name: true },
    });
    const have = new Set(existing.map((c) => c.name));
    const missing = DEFAULT_INCOME_CATEGORIES.filter((c) => !have.has(c.name));
    if (missing.length === 0) {
      console.log(`  ${w.name} (${w.id}): all 9 already present, skip`);
      continue;
    }
    await prisma.category.createMany({
      data: missing.map((c) => ({
        workspaceId: w.id,
        name: c.name,
        icon: c.icon,
        color: c.color,
        type: "income" as const,
      })),
    });
    inserted += missing.length;
    console.log(`  ${w.name} (${w.id}): inserted ${missing.length} (${missing.map((m) => m.name).join(", ")})`);
  }
  console.log(`Done. Inserted ${inserted} income category row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
