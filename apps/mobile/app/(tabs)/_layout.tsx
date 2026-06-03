import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ActivityIndicator, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../../src/design/tokens";
import { useSession } from "../../src/auth/client";
import { shouldRedirectToSignIn } from "../../src/auth/session-guard";
import { isBackendUnavailableError } from "../../src/api/backend-status";
import { MaintenanceScreen } from "../../src/api/MaintenanceScreen";

// Five-tab structure per Fina Mobile Designs. Add (manual / OCR) is a
// modal/sheet launched from Home/Activity FABs, not a tab.
export default function TabsLayout() {
  const sessionState = useSession() as ReturnType<typeof useSession> & {
    error?: unknown;
  };
  const insets = useSafeAreaInsets();
  if (isBackendUnavailableError(sessionState.error)) {
    return <MaintenanceScreen />;
  }
  if (sessionState.isPending) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.canvas,
        }}
      >
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  }
  if (
    shouldRedirectToSignIn({
      isPending: sessionState.isPending,
      hasUser: !!sessionState.data?.user,
    })
  ) {
    return <Redirect href="/(auth)/sign-in" />;
  }
  // Bottom safe-area inset on devices with a home indicator (modern
  // iPhones / some Androids) is non-zero; on the rest it's 0. Either
  // way we add a base 8px so the icons don't sit flush against the
  // indicator line, and grow the bar height to match.
  const bottomPad = Math.max(insets.bottom, 8);
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.canvas,
          borderTopColor: colors.hairlineSoft,
          paddingTop: 8,
          paddingBottom: bottomPad,
          height: 56 + bottomPad,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
          letterSpacing: 0.1,
          marginTop: 2,
        },
        tabBarItemStyle: {
          paddingVertical: 4,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home-outline" color={color} size={21} />
          ),
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list-outline" color={color} size={21} />
          ),
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubble-outline" color={color} size={21} />
          ),
        }}
      />
      <Tabs.Screen
        name="goals"
        options={{
          title: "Goals",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="flag-outline" color={color} size={21} />
          ),
        }}
      />
      <Tabs.Screen
        name="more"
        options={{
          title: "More",
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="ellipsis-horizontal" color={color} size={21} />
          ),
        }}
      />
    </Tabs>
  );
}
