import type { MeDTO } from "@fina/shared";

type BillingLockShape = Pick<MeDTO, "billingRecovery" | "iapIntegrity">;

export function isBillingLocked(me: BillingLockShape): boolean {
  return me.billingRecovery?.locked ?? me.iapIntegrity.isPlanMismatch;
}
