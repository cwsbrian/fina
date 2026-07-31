import { pathToFileURL } from "node:url";

import { loadRootEnv } from "./load-root-env.js";

loadRootEnv();

function readFlag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

export function parseDedupeReconnectArgs(argv: string[]): {
  email: string;
  apply: boolean;
  dateWindowDays: number;
} {
  const email = (readFlag(argv, "--email") ?? "").trim().toLowerCase();
  const apply = argv.includes("--apply");
  const confirmEmail = (readFlag(argv, "--confirm-email") ?? "").trim().toLowerCase();
  const dateWindowRaw = readFlag(argv, "--date-window-days") ?? "0";
  const dateWindowDays = Number(dateWindowRaw);
  if (!email.includes("@")) {
    throw new Error(
      "Usage: pnpm --filter @fina/api prod:dedupe-reconnect-transactions -- --email user@example.com [--date-window-days 0] [--apply --confirm-email user@example.com]",
    );
  }
  if (!Number.isInteger(dateWindowDays) || dateWindowDays < 0 || dateWindowDays > 3) {
    throw new Error("--date-window-days must be an integer from 0 to 3");
  }
  if (apply && confirmEmail !== email) {
    throw new Error("--apply requires --confirm-email with the exact same email address");
  }
  return { email, apply, dateWindowDays };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseDedupeReconnectArgs(argv);
  // Dynamic imports happen after the root .env has been loaded above. This
  // matters because db.ts captures DATABASE_URL while constructing Prisma.
  const [{ prisma }, { dedupeReconnectTransactionsByEmail }] = await Promise.all([
    import("../db.js"),
    import("../transactions/dedupe-reconnect.js"),
  ]);
  try {
    const result = await dedupeReconnectTransactionsByEmail(args.email, args);
    console.log(args.apply ? "Mode: APPLY" : "Mode: DRY RUN (no rows changed)");
    console.log(`User: ${result.email}`);
    console.log(`High-confidence reconnect duplicates: ${result.candidates.length}`);
    if (result.candidates.length > 0) {
      console.table(
        result.candidates.map((candidate) => ({
          merchant: candidate.merchant,
          amount: candidate.amount,
          oldDate: candidate.historicalOccurredAt.toISOString().slice(0, 10),
          newDate: candidate.currentOccurredAt.toISOString().slice(0, 10),
          matchedOn: candidate.matchBasis,
          dateDeltaDays: candidate.dateDeltaDays,
          subtypeChanged: candidate.subtypeChanged,
          oldAccount: candidate.historicalAccountName,
          currentAccount: candidate.currentAccountName,
          oldTransactionId: candidate.historicalTransactionId,
          currentTransactionId: candidate.currentTransactionId,
        })),
      );
    }
    if (args.apply) {
      console.log(`Soft-removed historical duplicates: ${result.softRemoved}`);
      console.log(`Skipped after safety re-check: ${result.skipped}`);
    } else if (result.candidates.length > 0) {
      console.log(
        `Review the table, then rerun with --apply --confirm-email ${result.email}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
