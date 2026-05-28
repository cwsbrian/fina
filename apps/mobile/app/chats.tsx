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
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { ChatThreadDTO } from "@fina/shared";
import { apiFetch } from "../src/api/client";
import { colors, space, type as type$ } from "../src/design/tokens";
import { HeaderIconButton } from "../src/design/HeaderIconButton";
import { useCollapsingHeader } from "../src/design/useCollapsingHeader";

const HEADER_HEIGHT = 58;

/** Pretty-print an ISO timestamp as a relative-then-absolute label for
 *  the chats list meta line. Returns "" when the input is null/missing.
 *
 *  - <1m ago    → "just now"
 *  - <60m ago   → "5m ago"
 *  - <24h ago   → "3h ago"
 *  - yesterday  → "Yesterday"
 *  - <7d ago    → "Mon" (weekday)
 *  - same year  → "May 5"
 *  - else       → "May 5, 2025"
 */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const nowMs = Date.now();
  const deltaMs = nowMs - t;
  if (deltaMs < 60_000) return "just now";
  if (deltaMs < 60 * 60_000) return `${Math.floor(deltaMs / 60_000)}m ago`;
  if (deltaMs < 24 * 60 * 60_000) return `${Math.floor(deltaMs / (60 * 60_000))}h ago`;

  const d = new Date(t);
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysAgo = Math.round((startOfToday.getTime() - startOfDay.getTime()) / (24 * 60 * 60_000));
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo > 1 && daysAgo < 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

type ThreadRow = ChatThreadDTO & {
  messageCount: number;
  firstMessagePreview: string | null;
  workspaceName: string | null;
};

type WorkspacesResp = { workspaces: Array<{ id: string }> };

// Chat history — opened from the Chat tab header's clock icon. Lists
// every past + current thread. Tapping a row drills into /chat/[tid].
export default function Chats() {
  const [threads, setThreads] = useState<ThreadRow[] | null>(null);
  const [workspaceCount, setWorkspaceCount] = useState<number>(1);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const insets = useSafeAreaInsets();
  const totalHeader = insets.top + HEADER_HEIGHT;
  const header = useCollapsingHeader(HEADER_HEIGHT);

  const load = useCallback(async () => {
    try {
      // Single workspace user → workspace tag on every chats row is
      // redundant. Hydrate the count alongside threads so the meta line
      // can omit it. The /workspaces call is cheap and the user already
      // hits it on every other tab.
      const [data, ws] = await Promise.all([
        apiFetch<{ threads: ThreadRow[] }>("/chat/threads"),
        apiFetch<WorkspacesResp>("/workspaces"),
      ]);
      setThreads(data.threads);
      setWorkspaceCount(ws.workspaces.length);
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
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Animated.View style={[styles.headerOverlay, { top: insets.top, height: HEADER_HEIGHT }, header.headerStyle]}>
        <View style={styles.header}>
          <HeaderIconButton
            icon="chevron-back"
            accessibilityLabel="Back"
            onPress={() => router.back()}
            variant="plain"
          />
          <Text style={styles.headerTitle}>Chat history</Text>
          <HeaderIconButton
            icon="create-outline"
            accessibilityLabel="New chat"
            onPress={onNewChat}
            variant="plain"
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
          contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: totalHeader, paddingBottom: space.xxl }}
          onScroll={header.onScroll}
          scrollEventThrottle={header.scrollEventThrottle}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              progressViewOffset={totalHeader}
            />
          }
          renderItem={({ item }) => {
            const unread = item.unreadCount > 0;
            return (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                onPress={() =>
                  router.push({
                    pathname: "/(tabs)/chat",
                    params: { thread: item.id },
                  } as never)
                }
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.titleRow}>
                    {unread && <View style={styles.unreadDot} />}
                    <Text
                      style={[
                        styles.rowTitle,
                        unread ? styles.rowTitleUnread : styles.rowTitleRead,
                      ]}
                      numberOfLines={1}
                    >
                      {item.title ?? item.firstMessagePreview ?? "New chat"}
                    </Text>
                  </View>
                  <Text style={[styles.rowMeta, !unread && styles.rowMetaRead]}>
                    {[
                      // Hide the workspace tag when the user is in a
                      // single workspace — every row would say the same
                      // name. Lazy/unassigned threads still surface that
                      // status so the user knows the thread hasn't been
                      // bound yet.
                      workspaceCount > 1
                        ? item.workspaceName ?? "Unassigned"
                        : item.workspaceName === null
                          ? "Unassigned"
                          : "",
                      relativeTime(item.lastMessageAt),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Text>
                </View>
                {unread ? (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadBadgeText}>
                      {item.unreadCount > 9 ? "9+" : item.unreadCount}
                    </Text>
                  </View>
                ) : (
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={colors.mutedSoft}
                  />
                )}
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
      <View style={[styles.statusBarBg, { height: insets.top }]} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  headerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: colors.canvas,
  },
  statusBarBg: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 11,
    backgroundColor: colors.canvas,
  },
  header: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
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
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { ...type$.titleSm, flex: 1, minWidth: 0 },
  // Unread = full ink + bold. Read = muted body color + regular weight —
  // a single visual variable (weight + color contrast) drives the
  // distinction so the list reads at a glance.
  rowTitleUnread: { fontWeight: "700", color: colors.ink },
  rowTitleRead: { fontWeight: "500", color: colors.body },
  rowMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  rowMetaRead: { color: colors.mutedSoft },
  sep: { height: 1, backgroundColor: colors.hairlineSoft },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadBadgeText: {
    ...type$.captionStrong,
    color: colors.onPrimary,
    fontSize: 11,
  },
});
