import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { ChatThreadDTO } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { ThreadView } from "../../src/chat/ThreadView";
import { colors, space, type as type$ } from "../../src/design/tokens";

// Chat tab opens directly into the most-recent thread (the morning
// ritual conversation). The history list is a drill-in opened from
// the header — `app/chats.tsx`.
export default function ChatTab() {
  const [currentThreadId, setCurrentThreadId] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadCurrent = useCallback(async () => {
    try {
      // Most-recent first (lastMessageAt desc — backend default).
      const data = await apiFetch<{ threads: ChatThreadDTO[] }>(
        "/chat/threads?limit=1",
      );
      if (data.threads.length === 0) {
        setEmpty(true);
        setCurrentThreadId(null);
      } else {
        setEmpty(false);
        setCurrentThreadId(data.threads[0]!.id);
      }
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadCurrent();
    }, [loadCurrent]),
  );

  const onNewChat = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const created = await apiFetch<{ thread: ChatThreadDTO }>("/chat/threads", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setCurrentThreadId(created.thread.id);
      setEmpty(false);
    } catch (e) {
      Alert.alert(
        "Could not start chat",
        (e as { code?: string }).code ?? "Try again in a moment.",
      );
    } finally {
      setCreating(false);
    }
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
          disabled={creating}
          hitSlop={8}
          accessibilityLabel="New chat"
        >
          <Ionicons name="create-outline" size={22} color={colors.ink} />
        </Pressable>
      </View>

      {err && (
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load chat</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={loadCurrent}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      )}

      {!err && !currentThreadId && !empty && (
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      )}

      {!err && empty && (
        <View style={styles.fallback}>
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
      )}

      {!err && currentThreadId && (
        <ThreadView threadId={currentThreadId} embedded />
      )}
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
    width: 40, height: 40,
    alignItems: "center", justifyContent: "center",
  },
  headerTitle: { ...type$.titleSm, color: colors.ink },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
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
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4, textAlign: "center" },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base, textAlign: "center" },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl, paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
});
