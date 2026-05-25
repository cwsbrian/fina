import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { PresentationBlock } from "@fina/shared";
import { apiFetch } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { PresentationBlock as Block } from "../../src/chat/PresentationBlock";

type Brief = {
  id: string;
  type: "daily" | "weekly" | "monthly";
  /** YYYY-MM-DD in the user's tz. */
  date: string;
  createdAt: string;
  threadId: string;
  messageId: string;
  messageCreatedAt: string;
  blocks: PresentationBlock[];
};

type LatestResp = { brief: Brief | null };

function relativeDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  const now = new Date();
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const dayMs = 86_400_000;
  const diff = Math.round((today.getTime() - date.getTime()) / dayMs);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return `${diff} days ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      date.getUTCFullYear() !== now.getUTCFullYear() ? "numeric" : undefined,
  });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function MorningBriefScreen() {
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<LatestResp>("/briefs/latest");
      setBrief(r.brief);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const openInChat = () => {
    if (!brief) {
      router.push("/(tabs)/chat" as never);
      return;
    }
    router.push({
      pathname: "/(tabs)/chat",
      params: { thread: brief.threadId },
    } as never);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.nav}>
        <HeaderIconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          variant="plain"
        />
        <Text style={styles.navTitle}>Morning brief</Text>
        <View style={{ width: 34 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {!loaded ? (
          <View style={styles.fallback}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : err ? (
          <View style={styles.fallback}>
            <Text style={styles.errTitle}>Couldn't load brief</Text>
            <Text style={styles.errBody}>{err}</Text>
            <Pressable style={styles.cta} onPress={load}>
              <Text style={styles.ctaText}>Try again</Text>
            </Pressable>
          </View>
        ) : !brief ? (
          <EmptyState />
        ) : (
          <>
            <View style={styles.dayRow}>
              <View style={styles.brand}>
                <View style={styles.brandDot} />
                <Text style={styles.brandText}>Fina · Morning brief</Text>
              </View>
              <Text style={styles.dayText}>
                {relativeDay(brief.date)} · {timeLabel(brief.messageCreatedAt)}
              </Text>
            </View>

            <View style={styles.bubble}>
              {(brief.blocks ?? []).map((b, i) => (
                <Block
                  key={i}
                  block={b}
                  role="assistant"
                />
              ))}
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.openBtn,
                pressed && { opacity: 0.85 },
              ]}
              onPress={openInChat}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.onPrimary} />
              <Text style={styles.openBtnText}>Continue in chat</Text>
            </Pressable>

            <Text style={styles.note}>
              Fina drops a fresh brief every morning. Edit timing or pause
              from More → Brief time.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function EmptyState() {
  return (
    <View style={styles.fallback}>
      <View style={styles.emptyGlyph}>
        <Ionicons name="sunny-outline" size={32} color={colors.muted} />
      </View>
      <Text style={styles.emptyTitle}>No brief yet</Text>
      <Text style={styles.emptyBody}>
        Fina sends a quick summary every morning. Once your first one lands —
        usually 8 AM — it'll show up here.
      </Text>
      <Pressable
        style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
        onPress={() => router.push("/(tabs)/chat" as never)}
      >
        <Text style={styles.ctaText}>Open chat instead</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  navTitle: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  scroll: { padding: space.lg, paddingBottom: space.xl },

  fallback: { alignItems: "center", paddingVertical: space.xxl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: {
    ...type$.bodyMd,
    color: colors.body,
    marginBottom: space.base,
    textAlign: "center",
  },
  emptyGlyph: {
    width: 64,
    height: 64,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.base,
  },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginBottom: 6 },
  emptyBody: {
    ...type$.bodyMd,
    color: colors.body,
    textAlign: "center",
    maxWidth: 320,
    marginBottom: space.lg,
  },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    borderRadius: 999,
  },
  ctaText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },

  dayRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: space.sm,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  brandDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  brandText: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  dayText: { ...type$.bodySm, color: colors.muted },

  bubble: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 18,
    padding: space.base,
    gap: space.sm,
  },

  openBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.primary,
    paddingVertical: 14,
    borderRadius: 999,
    marginTop: space.lg,
  },
  openBtnText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },

  note: {
    ...type$.bodySm,
    color: colors.muted,
    textAlign: "center",
    marginTop: space.base,
    paddingHorizontal: space.lg,
  },
});
