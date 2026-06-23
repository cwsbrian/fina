import { prisma } from "../db.js";

const LIFETIME_PRO_TRIAL_END = new Date("9999-12-31T23:59:59.000Z");

export type GrantProTrialResult = {
  id: string;
  email: string;
  trialEndsAt: Date;
  trialConsumed: boolean;
};

type GrantProTrialOptions = {
  until?: Date;
};

function readFlag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1 || idx === argv.length - 1) return null;
  return argv[idx + 1] ?? null;
}

function parseArgs(argv: string[]): { email: string | null; until: Date } {
  const flagIndex = argv.indexOf("--email");
  const email = flagIndex !== -1 ? argv[flagIndex + 1] ?? null : argv[0] ?? null;
  const untilRaw = readFlag(argv, "--until");
  const daysRaw = readFlag(argv, "--days");
  if (untilRaw && daysRaw) {
    throw new Error("Use only one of --until or --days");
  }
  if (daysRaw) {
    const days = Number(daysRaw);
    if (!Number.isInteger(days)) throw new Error("--days must be an integer");
    return { email, until: new Date(Date.now() + days * 86_400_000) };
  }
  if (untilRaw) return { email, until: parseUntil(untilRaw) };
  return { email, until: LIFETIME_PRO_TRIAL_END };
}

function parseUntil(value: string): Date {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error("--until must be a valid date");
  return date;
}

export async function grantProTrialByEmail(
  email: string,
  options: GrantProTrialOptions = {},
): Promise<GrantProTrialResult> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail.includes("@")) {
    throw new Error("Usage: fina-admin-grant-pro-trial user@example.com");
  }
  const until = options.until ?? LIFETIME_PRO_TRIAL_END;

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (!existing) {
    throw new Error(`User not found: ${normalizedEmail}`);
  }

  return await prisma.user.update({
    where: { id: existing.id },
    data: {
      trialEndsAt: until,
      trialConsumed: false,
    },
    select: {
      id: true,
      email: true,
      trialEndsAt: true,
      trialConsumed: true,
    },
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { email, until } = parseArgs(argv);
  if (!email) {
    throw new Error("Usage: fina-admin-grant-pro-trial user@example.com");
  }

  const updated = await grantProTrialByEmail(email, { until });
  console.log(
    JSON.stringify(
      {
        ...updated,
        trialEndsAt: updated.trialEndsAt.toISOString(),
      },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
