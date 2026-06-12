import type { Subscription, User, UserDevice } from "@prisma/client";
import type { BillingRecoveryDTO, SubscriptionDTO } from "@fina/shared";

type RecoverySub = Pick<Subscription, "source"> | null;
type RecoveryUser = Pick<User, "isPlanMismatch">;
type RecoveryDevice = Pick<UserDevice, "lastIapIntegrityCheckedAt"> | null;

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
): BillingRecoveryDTO {
  const source = (primary?.source ?? null) as SubscriptionDTO["source"] | null;
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

  return {
    locked: true,
    reason: "plan_mismatch",
    source,
    action: recoveryActionForSource(source),
    lastCheckedAt,
  };
}
