import type { SubscriptionSource } from "@fina/shared";

export type PlanEntryAction = "native-subscriptions" | "plan-screen" | "web-billing";

export function usesNativeSubscriptionSurface(platform: string): boolean {
  return platform === "ios";
}

export function planEntryAction(
  platform: string,
  source?: SubscriptionSource | null,
): PlanEntryAction {
  if (source === "stripe") return "web-billing";
  if (usesNativeSubscriptionSurface(platform)) return "native-subscriptions";
  return "plan-screen";
}

export function canOpenNativeSubscriptionSurface(
  platform: string,
  source?: SubscriptionSource | null,
): boolean {
  if (platform === "ios") return source !== "stripe";
  return Boolean(source);
}
