import { prisma } from "../db.js";

const USER_ROLES = ["user", "admin"] as const;
type UserRole = (typeof USER_ROLES)[number];

export type SetUserRoleResult = {
  id: string;
  email: string;
  role: UserRole;
};

function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value);
}

function readFlag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1 || idx === argv.length - 1) return null;
  return argv[idx + 1] ?? null;
}

function parseArgs(argv: string[]): { email: string | null; role: string | null } {
  const email = readFlag(argv, "--email");
  const role = readFlag(argv, "--role");
  if (email || role) return { email, role };
  return { email: argv[0] ?? null, role: argv[1] ?? null };
}

export async function setUserRoleByEmail(
  email: string,
  role: string,
): Promise<SetUserRoleResult> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!isUserRole(role)) {
    throw new Error(`Invalid role: ${role}`);
  }

  const existing = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, email: true },
  });
  if (!existing) {
    throw new Error(`User not found: ${normalizedEmail}`);
  }

  const updated = await prisma.user.update({
    where: { id: existing.id },
    data: { role },
    select: { id: true, email: true, role: true },
  });

  return {
    id: updated.id,
    email: updated.email,
    role: updated.role,
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { email, role } = parseArgs(argv);
  if (!email || !role || !isUserRole(role)) {
    throw new Error(
      "Usage: fina-admin-set-role user@example.com admin\n   or: pnpm admin:set-role -- --email user@example.com --role admin",
    );
  }

  const updated = await setUserRoleByEmail(email, role);
  console.log(JSON.stringify(updated, null, 2));
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
