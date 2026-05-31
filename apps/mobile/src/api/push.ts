import Constants from "expo-constants";
import { Platform } from "react-native";
import { apiFetch } from "./client";

type ExpoNotifications = typeof import("expo-notifications");

/** Lazy-require expo-notifications. We attempt the require everywhere,
 *  including Expo Go: on iOS Expo Go push delivery AND the foreground handler
 *  work, so blanket-disabling them there needlessly swallowed foreground
 *  banners and blocked token (re-)registration. Android Expo Go (SDK 53
 *  dropped remote push) degrades gracefully — getExpoPushTokenAsync throws and
 *  its caller returns null. The try wraps a possible module-load failure so the
 *  worst case is the previous no-op (never a crash); the only cost in Expo Go
 *  is a dev-only console warning on require. */
function getNotifications(): ExpoNotifications | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("expo-notifications") as ExpoNotifications;
  } catch {
    return null;
  }
}

/** Foreground display config — call once at startup so in-app pushes show a
 *  banner + sound instead of being swallowed silently. No-op only if
 *  expo-notifications can't load (see getNotifications). */
export function setupForegroundNotificationHandler(): void {
  const Notifications = getNotifications();
  if (!Notifications) return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** Subscribe to notification-tap responses. Returns a remover; in Expo Go it
 *  returns a stub so callers can unconditionally call `.remove()` on cleanup. */
export function addNotificationResponseListener(
  handler: () => void,
): { remove: () => void } {
  const Notifications = getNotifications();
  if (!Notifications) return { remove: () => {} };
  return Notifications.addNotificationResponseReceivedListener(handler);
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
  const Notifications = getNotifications();
  if (!Notifications) return null;
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
  const Notifications = getNotifications();
  if (!Notifications) return;
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
