import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Animated,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { ChatThreadDTO } from "@fina/shared";
import { apiFetch } from "../src/api/client";
import { colors, space, type as type$ } from "../src/design/tokens";
import { HeaderIconButton } from "../src/design/HeaderIconButton";
import { useCollapsingHeader } from "../src/design/useCollapsingHeader";

const HEADER_HEIGHT = 58;

type ThreadRow = ChatThreadDTO & {
  messageCount: number;
  firstMessagePreview: string | null;
};

// Chat history — opened from the Chat tab header's clock icon. Lists
// every past + current thread. Tapping a row drills into /chat/[tid].
export default function Chats() {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const header = useCollapsingHeader(HEADER_HEIGHT);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ threads: ThreadRow[] }>("/chat/threads");
      setThreads(data.threads);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const onNewChat = () => {
    // No DB write here — empty threads aren't persisted. Just go back
    // to the Chat tab, which lands on the pending state by default.
    router.replace("/(tabs)/chat" as never);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Animated.View style={[styles.headerOverlay, header.headerStyle]}>
        <View style={styles.header}>
          <HeaderIconButton
            icon="chevron-back"
            accessibilityLabel="Back"
            onPress={() => router.back()}
          />
          <Text style={styles.headerTitle}>Chat history</Text>
          <HeaderIconButton
            icon="create-outline"
            accessibilityLabel="New chat"
            onPress={onNewChat}
          />
        </View>
      </Animated.View>

      {threads === null && !err && (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      )}

      {err && (
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load history</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={onRefresh}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {threads && threads.length === 0 && !err && (
        <View style={styles.fallback}>
          <Text style={styles.emptyTitle}>No chats yet</Text>
          <Text style={styles.emptyBody}>
            Start a new conversation from the Chat tab.
          </Text>
        </View>
      )}

      {threads && threads.length > 0 && (
        <FlatList
          data={threads}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: HEADER_HEIGHT, paddingBottom: space.xxl }}
          onScroll={header.onScroll}
          scrollEventThrottle={header.scrollEventThrottle}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              progressViewOffset={HEADER_HEIGHT}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              onPress={() =>
                router.replace({
                  pathname: "/(tabs)/chat",
                  params: { thread: item.id },
                } as never)
              }
            >
              <View style={styles.rowGlyph}>
                <Ionicons
                  name="chatbubble-ellipses"
                  size={20}
                  color={colors.primary}
                />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.title ?? item.firstMessagePreview ?? "New chat"}
                </Text>
                <Text style={styles.rowMeta}>
                  {item.messageCount} message
                  {item.messageCount === 1 ? "" : "s"}
                  {item.lastMessageAt
                    ? ` · ${new Date(item.lastMessageAt).toLocaleDateString()}`
                    : ""}
                </Text>
              </View>
              <Ionicons
                name="chevron-forward"
                size={18}
                color={colors.mutedSoft}
              />
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
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
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginBottom: 4, textAlign: "center" },
  emptyBody: { ...type$.bodyMd, color: colors.body, textAlign: "center", maxWidth: 280 },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base, textAlign: "center" },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: space.sm + 2 },
  rowGlyph: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center", justifyContent: "center",
  },
  rowTitle: { ...type$.titleSm, color: colors.ink },
  rowMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  sep: { height: 1, backgroundColor: colors.hairlineSoft, marginLeft: 52 },
});
