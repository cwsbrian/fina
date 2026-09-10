import type { SubscriptionSource } from "@fina/shared";

export type PlanEntryAction = "plan-screen" | "web-billing";

export function usesNativeSubscriptionSurface(_platform: string): boolean {
  return false;
}

export function planEntryAction(
  platform: string,
  source?: SubscriptionSource | null,
): PlanEntryAction {
  if (source === "stripe") return "web-billing";
  return "plan-screen";
}

export function canOpenNativeSubscriptionSurface(
  platform: string,
  source?: SubscriptionSource | null,
): boolean {
  if (platform === "ios") return source === "iap_apple";
  return Boolean(source);
}
