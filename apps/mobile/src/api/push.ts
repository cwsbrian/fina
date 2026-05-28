import Constants from "expo-constants";
import { Platform } from "react-native";
import { apiFetch } from "./client";
import { isExpoGo } from "../env";

type ExpoNotifications = typeof import("expo-notifications");

/** Lazy-require expo-notifications. Returns null in Expo Go — SDK 53 removed
 *  remote push there, and the static import alone logs a red console.error.
 *  Push is unavailable in Expo Go regardless, so callers no-op. */
function getNotifications(): ExpoNotifications | null {
  if (isExpoGo) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("expo-notifications") as ExpoNotifications;
}

/** Sentinel value in apps/mobile/app.json `extra.eas.projectId`. Run
 *  `eas init` once the Expo project is initialized to overwrite it. */
const EAS_PROJECT_ID_PLACEHOLDER = "REPLACE_WITH_EAS_PROJECT_ID";

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
  if (!projectId || projectId === EAS_PROJECT_ID_PLACEHOLDER) {
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

/** Best-effort: re-fetches the current Expo push token + DELETE /devices.
 *  Called from sign-out flow BEFORE `signOut()` so the session cookie is
 *  still valid for the API call. Resolves the EAS projectId from
 *  Constants.expoConfig (falling back to legacy easConfig) and short-
 *  circuits if missing or still the REPLACE_WITH_EAS_PROJECT_ID
 *  placeholder. Failures swallowed: sign-out continues regardless; stale
 *  rows are eventually reaped by the next push's DeviceNotRegistered. */
export async function unregisterForPushNotifications(): Promise<void> {
  try {
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
    if (!projectId || projectId === EAS_PROJECT_ID_PLACEHOLDER) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await apiFetch("/devices", {
      method: "DELETE",
      body: JSON.stringify({ expoPushToken: token }),
    });
  } catch {
    // Best-effort — sign-out continues. Stale row falls back to lazy
    // DeviceNotRegistered cleanup on next push attempt.
  }
}
