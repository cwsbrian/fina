import { Stack } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { DateRangeSheetHost } from "../src/datetime/DateRangeSheetHost";
import { DatePickerSheetHost } from "../src/datetime/DatePickerSheetHost";
import { ThreadActionsSheetHost } from "../src/chat/ThreadActionsSheetHost";
import {
  registerForPushNotifications,
  setupForegroundNotificationHandler,
  addNotificationResponseListener,
} from "../src/api/push";
import { useSession } from "../src/auth/client";
import { syncDeviceTz } from "../src/api/tz-sync";

export default function RootLayout() {
  const { data: session } = useSession();

  useEffect(() => {
    // Initial sync on mount.
    syncDeviceTz();
    // Foreground push display config — banner + sound. No-op in Expo Go.
    setupForegroundNotificationHandler();
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
    const sub = addNotificationResponseListener(() => {
      // No-op. Future: route to specific chat thread via payload.data.
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <BottomSheetModalProvider>
          <DateRangeSheetHost>
            <DatePickerSheetHost>
              <ThreadActionsSheetHost>
                <Stack screenOptions={{ headerShown: false }} />
              </ThreadActionsSheetHost>
            </DatePickerSheetHost>
          </DateRangeSheetHost>
        </BottomSheetModalProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
