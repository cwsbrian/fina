import type { Subscription, User, UserDevice } from "@prisma/client";
import type { BillingRecoveryDTO, SubscriptionDTO } from "@fina/shared";

type RecoverySub = Pick<Subscription, "source"> | null;
type RecoveryUser = Pick<User, "isPlanMismatch" | "planMismatchAccountEmailMasked">;
type RecoveryDevice = Pick<UserDevice, "lastIapIntegrityCheckedAt"> | null;
type RecoveryPlatform = "ios" | "android" | null;

export function maskBillingRecoveryEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  const at = normalized.indexOf("@");
  if (at <= 0) return normalized;
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (local.length <= 1) return `${local}@${domain}`;
  if (local.length === 2) return `${local[0]}*@${domain}`;
  return `${local[0]}${"*".repeat(local.length - 2)}${local[local.length - 1]}@${domain}`;
}

function recoveryActionForSource(
  source: SubscriptionDTO["source"] | null,
): BillingRecoveryDTO["action"] {
  if (source === "iap_apple" || source === "iap_google") return "restore_iap";
  if (source === "stripe") return "sync_stripe";
  return null;
}

export function billingRecoveryForMe(
  user: RecoveryUser,
  primary: RecoverySub,
  device: RecoveryDevice,
  platform: RecoveryPlatform = null,
): BillingRecoveryDTO {
  const inferredNativeSource =
    !primary && platform === "ios"
      ? "iap_apple"
      : !primary && platform === "android"
        ? "iap_google"
        : null;
  const source = (primary?.source ?? inferredNativeSource) as SubscriptionDTO["source"] | null;
  const lastCheckedAt = device?.lastIapIntegrityCheckedAt?.toISOString() ?? null;

  if (!user.isPlanMismatch) {
    return {
      locked: false,
      reason: null,
      source: null,
      action: null,
      lastCheckedAt,
    };
  }

  const recovery: BillingRecoveryDTO = {
    locked: true,
    reason: "plan_mismatch",
    source,
    action: recoveryActionForSource(source),
    lastCheckedAt,
  };
  if (user.planMismatchAccountEmailMasked) {
    recovery.boundAccountEmailMasked = user.planMismatchAccountEmailMasked;
  }
  return recovery;
}
