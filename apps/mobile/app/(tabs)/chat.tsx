import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Animated } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router, useNavigation } from "expo-router";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { ThreadView } from "../../src/chat/ThreadView";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";

const HEADER_HEIGHT = 58;

// Tapping the Chat tab always lands on a fresh, pending thread (no DB
// row). The thread is created lazily on the user's first send — until
// then nothing persists. Historical conversations live in /chats.
export default function ChatTab() {
  const params = useLocalSearchParams<{ thread?: string }>();
  const navigation = useNavigation();
  const tabBarHeight = useBottomTabBarHeight();
  const header = useCollapsingHeader(HEADER_HEIGHT);
  // null = pending; a real id appears only when /chats explicitly
  // routes the user back to a specific thread via ?thread=<id>.
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  // Force ThreadView to fully reset (new keyed instance) when the
  // pencil is hit while already on the pending state.
  const [resetKey, setResetKey] = useState(0);

  useEffect(() => {
    if (params.thread) {
      setCurrentThreadId(params.thread);
      router.setParams({ thread: undefined } as never);
    }
  }, [params.thread]);

  const onNewChat = useCallback(() => {
    setCurrentThreadId(null);
    setResetKey((k) => k + 1);
  }, []);

  // Tapping the Chat tab while already on it should reset to a new
  // (pending) thread. tabPress fires for every tap; we trigger only
  // when the tab was ALREADY focused — switching from another tab
  // is handled by normal navigation focus.
  useEffect(() => {
    const unsub = navigation.addListener("tabPress" as never, (() => {
      if ((navigation as { isFocused: () => boolean }).isFocused()) {
        onNewChat();
      }
    }) as never);
    return unsub;
  }, [navigation, onNewChat]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ThreadView
        key={`${currentThreadId ?? "pending"}-${resetKey}`}
        threadId={currentThreadId}
        bottomInset={tabBarHeight}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
        listTopInset={HEADER_HEIGHT}
      />
      <Animated.View style={[styles.headerOverlay, header.headerStyle]}>
        <View style={styles.header}>
          <HeaderIconButton
            icon="time-outline"
            accessibilityLabel="Chat history"
            onPress={() => router.push("/chats" as never)}
          />
          <Text style={styles.headerTitle}>Chat</Text>
          <HeaderIconButton
            icon="create-outline"
            accessibilityLabel="New chat"
            onPress={onNewChat}
          />
        </View>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  headerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: colors.canvas,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    height: HEADER_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  headerTitle: { ...type$.titleSm, color: colors.ink },
});
