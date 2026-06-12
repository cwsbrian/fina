import type { MeDTO } from "@fina/shared";

type BillingLockShape = Pick<MeDTO, "billingRecovery" | "iapIntegrity">;
type BillingRecoveryShape = Pick<MeDTO, "billingRecovery" | "iapIntegrity" | "subscription">;

export function isBillingLocked(me: BillingLockShape): boolean {
  return me.billingRecovery?.locked ?? me.iapIntegrity.isPlanMismatch;
}

export function billingRecoveryButtonLabel(me: BillingRecoveryShape): string {
  switch (me.billingRecovery?.action ?? null) {
    case "sync_stripe":
      return "Sync billing";
    case "restore_iap":
      return "Restore purchases";
    case null:
      return "Contact support";
  }
}

export function billingRecoveryLockCopy(me: BillingRecoveryShape): string {
  if ((me.billingRecovery?.action ?? null) === null) {
    return "We could not determine where this subscription is managed.";
  }
  return "This Fina account and your billing provider do not match.";
}

export function billingRecoveryFootnote(me: BillingRecoveryShape, storeName: string): string {
  if (me.subscription?.source === "stripe" || me.billingRecovery?.action === "sync_stripe") {
    return "Fina web billing handles payment, cancellation, and subscription changes.";
  }
  return `${storeName} handles payment, cancellation, and subscription changes.`;
}
