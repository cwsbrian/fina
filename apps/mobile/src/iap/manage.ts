import { Linking, Platform } from "react-native";
import type { PaidTier, SubscriptionSource } from "@fina/shared";
import { isExpoGo } from "../env";

const ANDROID_PACKAGE = "com.withfina.app";

export function nativeBillingUnavailableMessage(
  source?: SubscriptionSource | null,
): string | null {
  if (!source) return null;
  if (source === "stripe") {
    return "This subscription is managed on the website.";
  }
  if (source === "iap_apple" && Platform.OS !== "ios") {
    return "This subscription was started in the App Store. Manage it from an iPhone, iPad, or your Apple account.";
  }
  if (source === "iap_google" && Platform.OS !== "android") {
    return "This subscription was started in Google Play. Manage it from an Android device using the same Google account.";
  }
  return null;
}

/** Open the platform-native subscription-management surface (App Store on
 *  iOS, Play Store on Android). Stateless — each caller owns its own busy /
 *  spinner state and awaits this. `tier` selects the Android deep-link SKU
 *  when the backend knows the user's current Google subscription; without a
 *  tier Android falls back to the Play subscriptions list. */
export async function openManageBilling(
  tier?: PaidTier,
  source?: SubscriptionSource | null,
): Promise<void> {
  const unavailable = nativeBillingUnavailableMessage(source);
  if (unavailable) throw new Error(unavailable);

  if (Platform.OS === "ios") {
    if (!isExpoGo) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const iap = require("react-native-iap") as typeof import("react-native-iap");
        if (typeof iap.deepLinkToSubscriptions === "function") {
          await iap.initConnection();
          await iap.deepLinkToSubscriptions();
          return;
        }
      } catch {
        // Fall back to the universal App Store account URL below.
      }
    }
    await Linking.openURL("https://apps.apple.com/account/subscriptions");
    return;
  }

  if (Platform.OS === "android") {
    const skuAndroid = tier === "max" ? "max_monthly" : tier === "pro" ? "pro_monthly" : undefined;
    if (!isExpoGo) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const iap = require("react-native-iap") as typeof import("react-native-iap");
        if (typeof iap.deepLinkToSubscriptions === "function") {
          await iap.initConnection();
          await iap.deepLinkToSubscriptions({
            packageNameAndroid: ANDROID_PACKAGE,
            ...(skuAndroid ? { skuAndroid } : {}),
          });
          return;
        }
      } catch {
        // Fall back to Play Store URLs below.
      }
    }
    const query = skuAndroid
      ? `?package=${ANDROID_PACKAGE}&sku=${encodeURIComponent(skuAndroid)}`
      : `?package=${ANDROID_PACKAGE}`;
    await Linking.openURL(
      `https://play.google.com/store/account/subscriptions${query}`,
    );
  }
}
