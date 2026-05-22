import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { apiFetch } from "./client";

/** Best-effort registration of this device's Expo push token with the
 *  Fina API. Idempotent: safe to call on every launch + on sign-in.
 *  Returns the token on success, null on any failure (permission denied,
 *  missing app config, API down, etc.).
 *
 *  Failures are silent — push is a "nice to have" wake-up channel; the
 *  brief still appears in the chat thread next time the app foregrounds. */
export async function registerForPushNotifications(): Promise<string | null> {
  // OS permission (iOS dialog / Android-13+ runtime).
  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;
  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }
  if (finalStatus !== "granted") return null;

  // Read EAS project ID — required by Expo SDK 54's getExpoPushTokenAsync.
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ??
    (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
  if (!projectId || projectId === "REPLACE_WITH_EAS_PROJECT_ID") {
    // EAS projectId not in app.json (or still the placeholder from T9). Silently
    // skip — add via `eas init` once the project is initialized on Expo's
    // dashboard. The placeholder check makes failure mode explicit instead of
    // relying on getExpoPushTokenAsync throwing.
    return null;
  }

  let token: string;
  try {
    const resp = await Notifications.getExpoPushTokenAsync({ projectId });
    token = resp.data;
  } catch {
    return null;
  }
  if (!token) return null;

  const platform = Platform.OS === "ios" ? "ios" : "android";
  try {
    await apiFetch("/devices", {
      method: "POST",
      body: JSON.stringify({ expoPushToken: token, platform }),
    });
  } catch {
    // Backend may be temporarily down. Token cached locally by Expo —
    // next launch will retry.
  }
  return token;
}
