import { prisma } from "../db.js";
import { hashBindingToken } from "./binding.js";

/** Future-deletion-flow integration point. Whoever builds the account-
 *  deletion flow MUST call this BEFORE removing the User row. Without
 *  it, IAP webhooks for the deleted user's purchases 500 for 5 retries
 *  before the per-token retry-cap trips (spec §5.3 step 4).
 *
 *  No-op for users who never made an IAP purchase. Idempotent — safe
 *  to call repeatedly (uses upsert under (source, tokenHash) unique). */
export async function writeAccountDeletionTombstones(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { iapAppleAccountToken: true, iapGoogleObfuscatedId: true },
  });
  if (!user) return;
  const tombstones: { source: "iap_apple" | "iap_google"; tokenHash: string }[] = [];
  if (user.iapAppleAccountToken) {
    tombstones.push({ source: "iap_apple", tokenHash: hashBindingToken(user.iapAppleAccountToken) });
  }
  if (user.iapGoogleObfuscatedId) {
    tombstones.push({ source: "iap_google", tokenHash: hashBindingToken(user.iapGoogleObfuscatedId) });
  }
  if (tombstones.length === 0) return;
  // Hash userId for support-replay; not reversible without the original userId.
  const userIdHash = hashBindingToken(userId);
  // Batch transaction — atomic across both upserts at the SQL layer.
  // Avoids the half-tombstoned state where Apple committed but Google failed.
  await prisma.$transaction(
    tombstones.map((t) =>
      prisma.iapDeletedBinding.upsert({
        where: { source_tokenHash: { source: t.source, tokenHash: t.tokenHash } },
        create: { source: t.source, tokenHash: t.tokenHash, userIdHash },
        update: {}, // idempotent
      }),
    ),
  );
}
