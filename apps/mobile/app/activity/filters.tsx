import { useEffect, useRef } from "react";
import { View } from "react-native";
import { Stack, router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ActivityFilterScreen } from "../../src/activity/ActivityFilterScreen";
import {
  clearActivityFilterNavigation,
  getActivityFilterNavigation,
} from "../../src/activity/filter-navigation";
import { colors } from "../../src/design/tokens";

export default function ActivityFiltersRoute() {
  const insets = useSafeAreaInsets();
  const request = useRef(getActivityFilterNavigation()).current;

  useEffect(() => {
    if (!request) router.back();
    return () => clearActivityFilterNavigation();
  }, [request]);

  const close = () => {
    clearActivityFilterNavigation();
    router.back();
  };

  if (!request) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <Stack.Screen options={{ animation: "slide_from_right", gestureEnabled: true }} />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ animation: "slide_from_right", gestureEnabled: true }} />
      <ActivityFilterScreen
        visible
        topInset={insets.top}
        bottomInset={insets.bottom}
        filters={request.filters}
        categories={request.categories}
        onClose={close}
        onApply={(filters) => {
          request.onApply(filters);
          close();
        }}
      />
    </>
  );
}
