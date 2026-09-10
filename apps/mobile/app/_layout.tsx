import { Stack, router, useSegments } from "expo-router";
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
  getLastNotificationResponseAsync,
  type PushNotificationResponse,
} from "../src/api/push";
import { useSession } from "../src/auth/client";
import { syncDeviceTz } from "../src/api/tz-sync";
import { notificationRouteForData } from "../src/api/push-routing";
import { syncAppleSignupEnvironment } from "../src/distribution/sync";
import { useActiveWorkspace } from "../src/workspace/useActiveWorkspace";

export default function RootLayout() {
  const { data: session } = useSession();
  const segments = useSegments();
  const { workspace, reload: reloadWorkspace } = useActiveWorkspace();

  useEffect(() => {
    if (session?.user?.id) reloadWorkspace();
  }, [session?.user?.id, reloadWorkspace]);

  useEffect(() => {
    const personalOnly = segments.some((segment) => ["goals", "goal", "budget", "analysis"].includes(segment));
    const businessOnly = segments.some((segment) => ["expenses", "receipts"].includes(segment));
    if ((workspace?.kind === "business" && personalOnly) || (workspace?.kind === "personal" && businessOnly)) router.replace("/(tabs)" as never);
  }, [segments, workspace?.kind]);

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
    syncAppleSignupEnvironment().catch(() => {});
  }, [session?.user?.id]);

  useEffect(() => {
    let mounted = true;
    const handleNotificationResponse = (response: PushNotificationResponse) => {
      const route = notificationRouteForData(response.notification.request.content.data);
      if (route) router.push(route as never);
    };

    getLastNotificationResponseAsync()
      .then((response) => {
        if (mounted && response) handleNotificationResponse(response);
      })
      .catch(() => {});

    const sub = addNotificationResponseListener(handleNotificationResponse);
    return () => {
      mounted = false;
      sub.remove();
    };
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
