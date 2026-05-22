import AsyncStorage from "@react-native-async-storage/async-storage";
import { apiFetch } from "./client";

const TZ_SYNC_KEY = "fina.tz.lastSyncAt";
const TZ_CACHE_KEY = "fina.tz.lastSynced";
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/** Best-effort device tz sync. Reads device IANA tz, compares with cached
 *  value + last-sync timestamp; if changed AND >6h since last call, sends
 *  PATCH /me { tz }. Silent on network / API errors. */
export async function syncDeviceTz(): Promise<void> {
  try {
    const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!deviceTz) return;

    const cached = await AsyncStorage.getItem(TZ_CACHE_KEY);
    const lastSyncStr = await AsyncStorage.getItem(TZ_SYNC_KEY);
    const lastSync = lastSyncStr ? Number(lastSyncStr) : 0;
    const now = Date.now();

    // Skip if same tz AND within throttle window.
    if (cached === deviceTz && now - lastSync < SIX_HOURS_MS) return;

    await apiFetch("/me", {
      method: "PATCH",
      body: JSON.stringify({ tz: deviceTz }),
    });
    await AsyncStorage.setItem(TZ_CACHE_KEY, deviceTz);
    await AsyncStorage.setItem(TZ_SYNC_KEY, String(now));
  } catch {
    // Swallow — tz sync is best-effort. Server still has previous tz.
  }
}
