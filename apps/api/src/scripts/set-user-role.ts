import { isUserRole, type UserRole } from "@fina/shared";
import { prisma } from "../db.js";

export type SetUserRoleResult = {
  id: string;
  email: string;
  role: UserRole;
};

function readFlag(argv: string[], name: string): string | null {
  const idx = argv.indexOf(name);
  if (idx === -1 || idx === argv.length - 1) return null;
  return argv[idx + 1] ?? null;
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
  const email = readFlag(argv, "--email");
  const role = readFlag(argv, "--role");
  if (!email || !role || !isUserRole(role)) {
    throw new Error(
      "Usage: pnpm --filter @fina/api admin:set-role -- --email user@example.com --role admin",
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
