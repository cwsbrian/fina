import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import { ThreadView } from "../../src/chat/ThreadView";
import { colors, space, type as type$ } from "../../src/design/tokens";

// Tapping the Chat tab always lands on a fresh, pending thread (no DB
// row). The thread is created lazily on the user's first send — until
// then nothing persists. Historical conversations live in /chats.
export default function ChatTab() {
  const params = useLocalSearchParams<{ thread?: string }>();
  const tabBarHeight = useBottomTabBarHeight();
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

  const onNewChat = () => {
    setCurrentThreadId(null);
    setResetKey((k) => k + 1);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          style={({ pressed }) => [styles.headerBtn, pressed && { opacity: 0.5 }]}
          onPress={() => router.push("/chats" as never)}
          hitSlop={8}
          accessibilityLabel="Chat history"
        >
          <Ionicons name="time-outline" size={22} color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Chat</Text>
        <Pressable
          style={({ pressed }) => [styles.headerBtn, pressed && { opacity: 0.5 }]}
          onPress={onNewChat}
          hitSlop={8}
          accessibilityLabel="New chat"
        >
          <Ionicons name="create-outline" size={22} color={colors.ink} />
        </Pressable>
      </View>

      <ThreadView
        key={`${currentThreadId ?? "pending"}-${resetKey}`}
        threadId={currentThreadId}
        bottomInset={tabBarHeight}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  headerBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { ...type$.titleSm, color: colors.ink },
});
