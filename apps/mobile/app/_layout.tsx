import { Stack } from "expo-router";
import { useEffect } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { syncDeviceTz } from "../src/api/tz-sync";

export default function RootLayout() {
  useEffect(() => {
    // Initial sync on mount.
    syncDeviceTz();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") syncDeviceTz();
    });
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </SafeAreaProvider>
  );
}
