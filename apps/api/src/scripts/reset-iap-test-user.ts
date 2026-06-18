import { prisma } from "../db.js";

export type ResetIapTestUserResult = {
  id: string;
  email: string;
  deletedNativeSubscriptions: number;
  clearedIapDeviceStates: number;
};

function parseEmail(argv: string[]): string | null {
  const flagIndex = argv.indexOf("--email");
  if (flagIndex !== -1) return argv[flagIndex + 1] ?? null;
  return argv[0] ?? null;
}

export async function resetIapTestUser(email: string): Promise<ResetIapTestUserResult> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail.includes("@")) {
    throw new Error("Usage: pnpm prod:reset-iap-test-user -- tester@test.com");
  }

  return await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true },
    });
    if (!user) throw new Error(`User not found: ${normalizedEmail}`);

    const deleted = await tx.subscription.deleteMany({
      where: {
        userId: user.id,
        source: { in: ["iap_apple", "iap_google"] },
      },
    });

    const clearedDevices = await tx.userDevice.updateMany({
      where: { userId: user.id },
      data: {
        lastIapIntegrityCheckedAt: null,
        lastIapIntegrityResult: null,
        lastIapIntegritySubscriptionUpdatedAt: null,
      },
    });

    const updated = await tx.user.update({
      where: { id: user.id },
      data: {
        isPlanMismatch: false,
        iapAppleAccountToken: null,
        iapGoogleObfuscatedId: null,
      },
      select: { id: true, email: true },
    });

    return {
      id: updated.id,
      email: updated.email,
      deletedNativeSubscriptions: deleted.count,
      clearedIapDeviceStates: clearedDevices.count,
    };
  });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const email = parseEmail(argv);
  if (!email) {
    throw new Error("Usage: pnpm prod:reset-iap-test-user -- tester@test.com");
  }

  const result = await resetIapTestUser(email);
  console.log(JSON.stringify(result, null, 2));
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
