import { Stack } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import * as Notifications from "expo-notifications";
import { registerForPushNotifications } from "../src/api/push";
import { useSession } from "../src/auth/client";
import { syncDeviceTz } from "../src/api/tz-sync";

export default function RootLayout() {
  const { data: session } = useSession();

  useEffect(() => {
    // Initial sync on mount.
    syncDeviceTz();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") syncDeviceTz();
    });
    return () => sub.remove();
  }, []);

  // Push registration — gated by session. iOS would otherwise pop the
  // permission dialog on first cold launch BEFORE the user has even
  // created an account. registerForPushNotifications is idempotent +
  // best-effort; safe to re-fire whenever userId changes.
  useEffect(() => {
    if (!session?.user?.id) return;
    registerForPushNotifications().catch(() => {});
  }, [session?.user?.id]);

  useEffect(() => {
    // V1: tap → app launch is enough. No deep-link routing yet (Plan 2D).
    // Listener exists so Expo doesn't complain about unhandled responses.
    const sub = Notifications.addNotificationResponseReceivedListener(() => {
      // No-op. Future: route to specific chat thread via payload.data.
    });
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
