import { Linking, Platform } from "react-native";
import type { PaidTier } from "@fina/shared";

/** Open the platform-native subscription-management surface (App Store on
 *  iOS, Play Store on Android). Stateless — each caller owns its own busy /
 *  spinner state and awaits this. `tier` selects the Android deep-link SKU;
 *  ignored on iOS, and on Android a missing tier just no-ops (matches the
 *  prior inline behaviour for a user with no sub on file). */
export async function openManageBilling(tier?: PaidTier): Promise<void> {
  if (Platform.OS === "ios") {
    await Linking.openURL("https://apps.apple.com/account/subscriptions");
    return;
  }
  if (Platform.OS === "android" && tier) {
    const productId = tier === "pro" ? "pro_monthly" : "lite_monthly";
    await Linking.openURL(
      `https://play.google.com/store/account/subscriptions?package=app.fina&sku=${encodeURIComponent(productId)}`,
    );
  }
}
