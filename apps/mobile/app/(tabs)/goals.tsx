import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import type { GoalDTO, MeDTO as Me } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";
import { formatMoney } from "../../src/format/money";
import {
  goalAccent,
  goalIcon,
  withAlpha,
  goalStatus,
  formatDue,
} from "../../src/goals/meta";

const HEADER_HEIGHT = 58;

export default function Goals() {
  const [me, setMe] = useState<Me | null>(null);
  const [goals, setGoals] = useState<GoalDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const insets = useSafeAreaInsets();
  const totalHeader = insets.top + HEADER_HEIGHT;
  const header = useCollapsingHeader(HEADER_HEIGHT);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Me>("/me")
      .then((m) => !cancelled && setMe(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const tier = me?.tier ?? "free";
  const trialActive = me?.trial?.active ?? false;
  const canSeeGoals = tier === "pro" || trialActive;

  const load = useCallback(async () => {
    if (!canSeeGoals) return;
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const data = await apiFetch<{ goals: GoalDTO[] }>(
        `/workspaces/${wsId}/goals`,
      );
      setGoals(data.goals);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, [canSeeGoals]);

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

  if (!canSeeGoals) {
    return <LockedGoals />;
  }

  // Active + monthly aside summary (per design: "4 active · $510/mo set aside")
  const active = (goals ?? []).filter((g) => !g.archivedAt);
  const monthlyAside = active.reduce((sum, g) => {
    const target = Number(g.targetAmount);
    const saved = Number(g.savedAmount);
    const due = new Date(g.dueDate);
    const months = Math.max(1, monthsBetween(new Date(), due));
    return sum + Math.max(0, (target - saved) / months);
  }, 0);

  return (
    <View style={styles.safe}>
      <FlatList
        data={active}
        keyExtractor={(g) => g.id}
        contentContainerStyle={[
          styles.list,
          { paddingTop: totalHeader },
          // When the list is empty the empty-state should sit dead-center,
          // not hug the top under the header.
          active.length === 0 && {
            flexGrow: 1,
            justifyContent: "center",
          },
        ]}
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
        ListHeaderComponent={
          active.length > 0 ? (
            <Text style={styles.summary}>
              {active.length} active · {formatMoney(monthlyAside.toFixed(2)).display}/mo set aside
            </Text>
          ) : null
        }
        renderItem={({ item }) => (
          <GoalCard
            goal={item}
            onPress={() => router.push(`/goals/${item.id}` as never)}
          />
        )}
        ListEmptyComponent={
          goals === null && !err ? (
            <View style={styles.fallback}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : err ? (
            <View style={styles.fallback}>
              <Text style={styles.errTitle}>Couldn't load goals</Text>
              <Text style={styles.errBody}>{err}</Text>
              <Pressable style={styles.cta} onPress={load}>
                <Text style={styles.ctaText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.fallback}>
              <View style={styles.iconWrap}>
                <Ionicons name="flag-outline" size={32} color={colors.muted} />
              </View>
              <Text style={styles.emptyTitle}>No goals yet</Text>
              <Text style={styles.emptyBody}>
                Set a target — a trip, a laptop, a down payment — and Fina will
                help you pace it.
              </Text>
              <Pressable
                style={({ pressed }) => [
                  styles.cta,
                  pressed && { opacity: 0.85 },
                ]}
                onPress={() => router.push("/goals/new" as never)}
              >
                <Text style={styles.ctaText}>Create a goal</Text>
              </Pressable>
            </View>
          )
        }
      />

      <Animated.View
        style={[
          styles.headerOverlay,
          { top: insets.top, height: HEADER_HEIGHT },
          header.headerStyle,
        ]}
      >
        <View style={styles.head}>
          <Text style={styles.title}>Goals</Text>
          <HeaderIconButton
            icon="add"
            size={22}
            accessibilityLabel="New goal"
            onPress={() => router.push("/goals/new" as never)}
          />
        </View>
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />
    </View>
  );
}

function GoalCard({ goal, onPress }: { goal: GoalDTO; onPress: () => void }) {
  const target = Number(goal.targetAmount);
  const saved = Number(goal.savedAmount);
  const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
  const accent = goalAccent(goal);
  const icon = goalIcon(goal);
  const due = new Date(goal.dueDate);
  const status = goalStatus({
    saved,
    target,
    due,
    now: new Date(),
    createdAt: new Date(goal.createdAt),
  });

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        pressed && { backgroundColor: colors.surfaceSoft },
      ]}
    >
      <View style={styles.cardHead}>
        <View
          style={[styles.cardGlyph, { backgroundColor: withAlpha(accent, 0.12) }]}
        >
          <Ionicons name={icon} size={16} color={accent} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {goal.title}
          </Text>
          <Text style={styles.cardMeta}>
            ${target.toLocaleString()} · {formatDue(due, new Date())}
          </Text>
        </View>
        <View
          style={[styles.statusPill, { backgroundColor: statusPillBg(status) }]}
        >
          <Text style={[styles.statusPillText, { color: statusPillFg(status) }]}>
            {status === "on-track"
              ? "On track"
              : status === "behind"
                ? "Behind"
                : status === "done"
                  ? "Done"
                  : "Paused"}
          </Text>
        </View>
      </View>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: accent }]} />
      </View>
      <View style={styles.cardFoot}>
        <Text style={styles.foot}>${saved.toLocaleString()} saved</Text>
        <Text style={styles.foot}>{pct}%</Text>
      </View>
    </Pressable>
  );
}

function statusPillBg(s: ReturnType<typeof goalStatus>): string {
  if (s === "on-track") return withAlpha(colors.up, 0.14);
  if (s === "behind") return "#fde6e7";
  if (s === "done") return withAlpha(colors.primary, 0.14);
  return colors.surfaceSoft;
}
function statusPillFg(s: ReturnType<typeof goalStatus>): string {
  if (s === "on-track") return colors.up;
  if (s === "behind") return "#b54550";
  if (s === "done") return colors.primary;
  return colors.muted;
}

function monthsBetween(a: Date, b: Date): number {
  return (
    (b.getFullYear() - a.getFullYear()) * 12 +
    (b.getMonth() - a.getMonth())
  );
}

function LockedGoals() {
  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.head}>
        <Text style={styles.title}>Goals</Text>
      </View>
      <View style={styles.body}>
        <View style={styles.iconWrap}>
          <Ionicons name="lock-closed" size={36} color={colors.muted} />
        </View>
        <Text style={styles.emptyTitle}>Pro feature</Text>
        <Text style={styles.emptyBody}>
          Goals are part of the Pro tier (free during your trial). Upgrade to
          plan and save toward what you care about.
        </Text>
      </View>
    </SafeAreaView>
  );
}

// react-native Animated import for the collapsing header overlay.
import { Animated } from "react-native";

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
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.sm,
    height: HEADER_HEIGHT,
  },
  title: { ...type$.titleLg, color: colors.ink },
  summary: {
    ...type$.bodySm,
    color: colors.muted,
    marginBottom: space.sm,
  },
  body: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.base,
  },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginBottom: 6, textAlign: "center" },
  emptyBody: {
    ...type$.bodyMd,
    color: colors.body,
    textAlign: "center",
    maxWidth: 320,
    marginBottom: space.lg,
  },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  fallback: { paddingVertical: space.xl, alignItems: "center" },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xl, gap: 14 },

  // Goal card
  card: {
    backgroundColor: colors.canvas,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    padding: space.base,
    gap: space.sm,
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.sm + 2 },
  cardGlyph: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { ...type$.titleSm, color: colors.ink },
  cardMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  statusPillText: { ...type$.bodySm, fontWeight: "600" },
  bar: {
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
  },
  barFill: { height: "100%", borderRadius: 999 },
  cardFoot: { flexDirection: "row", justifyContent: "space-between" },
  foot: { ...type$.bodySm, color: colors.muted },
});
