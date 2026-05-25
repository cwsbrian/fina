import { Stack } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { DateRangeSheetHost } from "../src/datetime/DateRangeSheetHost";
import * as Notifications from "expo-notifications";
import { registerForPushNotifications } from "../src/api/push";
import { useSession } from "../src/auth/client";
import { syncDeviceTz } from "../src/api/tz-sync";

// Show banner + play sound when a push arrives while the app is
// foregrounded. Without this, expo-notifications swallows in-app
// pushes silently — which makes test buttons feel broken even when
// the push went through.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

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
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          <DateRangeSheetHost>
            <Stack screenOptions={{ headerShown: false }} />
          </DateRangeSheetHost>
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
