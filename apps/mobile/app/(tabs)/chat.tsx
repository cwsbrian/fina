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
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { ChatThreadDTO } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";

type ThreadRow = ChatThreadDTO & {
  messageCount: number;
  firstMessagePreview: string | null;
};

export default function ChatList() {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ threads: ThreadRow[] }>("/chat/threads");
      setThreads(data.threads);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  // Re-fetch every time the tab gains focus — keeps the unread / last-
  // message timestamps fresh after the user comes back from a detail
  // screen or the app returns from background.
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

  const onNewChat = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await apiFetch<{ thread: ChatThreadDTO }>("/chat/threads", {
        method: "POST",
        body: JSON.stringify({}),
      });
      router.push(`/chat/${created.thread.id}` as never);
    } catch (e) {
      Alert.alert(
        "Could not start chat",
        (e as { code?: string }).code ?? "Try again in a moment.",
      );
    } finally {
      setCreating(false);
    }
  };

  if (threads === null && !err) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.head}>
          <Text style={styles.title}>Chat</Text>
        </View>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (err) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.head}>
          <Text style={styles.title}>Chat</Text>
        </View>
        <View style={styles.empty}>
          <Text style={styles.errTitle}>Couldn't load chats</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={onRefresh}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const list = threads ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.head}>
        <Text style={styles.title}>Chat</Text>
        <Pressable
          style={({ pressed }) => [styles.newBtn, pressed && { opacity: 0.7 }]}
          onPress={onNewChat}
          disabled={creating}
        >
          <Ionicons name="add" size={22} color={colors.primary} />
        </Pressable>
      </View>

      {list.length === 0 ? (
        <View style={styles.empty}>
          <View style={styles.iconWrap}>
            <Ionicons
              name="chatbubble-ellipses-outline"
              size={36}
              color={colors.muted}
            />
          </View>
          <Text style={styles.emptyTitle}>Your morning brief lives here</Text>
          <Text style={styles.emptyBody}>
            Each morning Fina prepares a short brief — confirm categories,
            review anomalies, and ask questions.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
            onPress={onNewChat}
            disabled={creating}
          >
            <Text style={styles.ctaText}>
              {creating ? "Starting…" : "Start a chat"}
            </Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.xxl }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
              onPress={() => router.push(`/chat/${item.id}` as never)}
            >
              <View style={styles.rowGlyph}>
                <Ionicons name="chatbubble-ellipses" size={20} color={colors.primary} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.rowTitle} numberOfLines={1}>
                  {item.title ?? item.firstMessagePreview ?? "New chat"}
                </Text>
                <Text style={styles.rowMeta}>
                  {item.messageCount} message{item.messageCount === 1 ? "" : "s"}
                  {item.lastMessageAt
                    ? ` · ${new Date(item.lastMessageAt).toLocaleDateString()}`
                    : ""}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.mutedSoft} />
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
  head: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: space.lg,
    paddingBottom: 8,
  },
  title: { ...type$.titleLg, color: colors.ink },
  newBtn: {
    width: 38,
    height: 38,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  iconWrap: {
    width: 72, height: 72, borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center", justifyContent: "center",
    marginBottom: space.base,
  },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginBottom: 6, textAlign: "center" },
  emptyBody: {
    ...type$.bodyMd, color: colors.body, textAlign: "center",
    maxWidth: 320, marginBottom: space.lg,
  },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl, paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base, textAlign: "center" },
  row: {
    flexDirection: "row", alignItems: "center", gap: space.sm,
    paddingVertical: space.sm + 2,
  },
  rowGlyph: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center", justifyContent: "center",
  },
  rowTitle: { ...type$.titleSm, color: colors.ink },
  rowMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  sep: { height: 1, backgroundColor: colors.hairlineSoft, marginLeft: 52 },
});
