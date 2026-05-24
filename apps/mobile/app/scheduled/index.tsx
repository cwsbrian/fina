import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { formatMoney } from "../../src/format/money";
import { categoryMeta } from "../../src/categories/meta";

type ScheduleStatus =
  | "upcoming"
  | "unresolved"
  | "resolved-matched"
  | "resolved-dismissed";

type Schedule = {
  id: string;
  categoryId: string;
  amount: string;
  scheduledDate: string;
  note: string | null;
  matchedTxId: string | null;
  dismissedAt: string | null;
  status: ScheduleStatus;
};

type ListResp = { schedules: Schedule[] };

type Bucket = {
  key: "thisWeek" | "thisMonth" | "nextMonth" | "later";
  label: string;
  rows: Schedule[];
};

function parseDateOnly(s: string): Date {
  // schedule.scheduledDate is YYYY-MM-DD (UTC). Build a midnight-UTC Date.
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
}

function startOfDayUTC(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function formatDateLabel(d: Date): string {
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function bucketize(schedules: Schedule[]): Bucket[] {
  const today = startOfDayUTC(new Date());
  const weekEnd = new Date(today.getTime() + 7 * 86_400_000);
  const thisMonth = today.getUTCMonth();
  const thisYear = today.getUTCFullYear();
  const nextMonthDate = new Date(Date.UTC(thisYear, thisMonth + 1, 1));

  const buckets: Bucket[] = [
    { key: "thisWeek", label: "This week", rows: [] },
    { key: "thisMonth", label: "Later this month", rows: [] },
    { key: "nextMonth", label: "Next month", rows: [] },
    { key: "later", label: "Later", rows: [] },
  ];

  for (const s of schedules) {
    const d = parseDateOnly(s.scheduledDate);
    if (d < weekEnd) {
      buckets[0]!.rows.push(s);
    } else if (
      d.getUTCFullYear() === thisYear &&
      d.getUTCMonth() === thisMonth
    ) {
      buckets[1]!.rows.push(s);
    } else if (
      d.getUTCFullYear() === nextMonthDate.getUTCFullYear() &&
      d.getUTCMonth() === nextMonthDate.getUTCMonth()
    ) {
      buckets[2]!.rows.push(s);
    } else {
      buckets[3]!.rows.push(s);
    }
  }
  return buckets.filter((b) => b.rows.length > 0);
}

function monthHeroLabel(): string {
  const d = new Date();
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

export default function ScheduledScreen() {
  const [schedules, setSchedules] = useState<Schedule[] | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [list, cats] = await Promise.all([
        apiFetch<ListResp>(
          `/workspaces/${wsId}/schedules?status=upcoming`,
        ),
        apiFetch<{ categories: CategoryDTO[] }>(
          `/workspaces/${wsId}/categories`,
        ),
      ]);
      setSchedules(list.schedules);
      setCategories(
        Object.fromEntries(cats.categories.map((c) => [c.id, c])),
      );
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

  if (err) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load schedule</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!schedules) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  // Hero: total of items scheduled in the current calendar month.
  const today = startOfDayUTC(new Date());
  const inThisMonth = schedules.filter((s) => {
    const d = parseDateOnly(s.scheduledDate);
    return (
      d.getUTCFullYear() === today.getUTCFullYear() &&
      d.getUTCMonth() === today.getUTCMonth() &&
      d >= today
    );
  });
  const monthTotal = inThisMonth.reduce(
    (sum, s) => sum + Number(s.amount),
    0,
  );

  const buckets = bucketize(schedules);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header
        onAdd={() =>
          Alert.alert(
            "Schedule something",
            "Schedule creation from the app is coming soon. For now ask Fina in chat — e.g. \"schedule $50 dentist on May 30\".",
          )
        }
      />
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
        {schedules.length === 0 ? (
          <View style={styles.fallback}>
            <View style={styles.iconWrap}>
              <Ionicons name="calendar-outline" size={36} color={colors.muted} />
            </View>
            <Text style={styles.emptyTitle}>Nothing scheduled</Text>
            <Text style={styles.emptyBody}>
              Plan a future spend so it shows up against your budget — ask Fina
              in chat, e.g. "schedule $50 for the dentist on May 30".
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.hero}>
              <Text style={styles.heroLabel}>{monthHeroLabel()}</Text>
              <Text style={styles.heroAmount}>
                {formatMoney(monthTotal.toFixed(2)).display}
              </Text>
              <View style={styles.heroMeta}>
                <Text style={styles.heroMetaText}>
                  {inThisMonth.length} scheduled item
                  {inThisMonth.length === 1 ? "" : "s"}
                </Text>
                <View style={styles.heroDot} />
                <Text style={styles.heroMetaTextMuted}>Pulls from budget</Text>
              </View>
            </View>

            {buckets.map((b) => (
              <View key={b.key} style={styles.section}>
                <Text style={styles.sectionTitle}>{b.label}</Text>
                {b.rows.map((s) => (
                  <ScheduledRow
                    key={s.id}
                    schedule={s}
                    category={categories[s.categoryId] ?? null}
                  />
                ))}
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ScheduledRow({
  schedule,
  category,
}: {
  schedule: Schedule;
  category: CategoryDTO | null;
}) {
  const meta = categoryMeta(category);
  const d = parseDateOnly(schedule.scheduledDate);
  const catName = category?.name ?? "Uncategorized";
  return (
    <View style={styles.row}>
      <View style={[styles.glyph, { backgroundColor: meta.bg }]}>
        <Ionicons name={meta.icon} size={16} color={meta.fg} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {catName}
        </Text>
        {schedule.note && (
          <Text style={styles.rowNote} numberOfLines={1}>
            {schedule.note}
          </Text>
        )}
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowAmount}>
          −{formatMoney(schedule.amount).display}
        </Text>
        <Text style={styles.rowDate}>{formatDateLabel(d)}</Text>
      </View>
    </View>
  );
}

function Header({ onAdd }: { onAdd?: () => void } = {}) {
  return (
    <View style={styles.nav}>
      <HeaderIconButton
        icon="chevron-back"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        variant="plain"
      />
      <Text style={styles.navTitle}>Scheduled</Text>
      {onAdd ? (
        <HeaderIconButton
          icon="add"
          accessibilityLabel="Add scheduled item"
          onPress={onAdd}
          variant="plain"
        />
      ) : (
        <View style={{ width: 34 }} />
      )}
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
  scroll: { paddingBottom: space.xl },
  fallback: {
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
    paddingTop: space.xxl,
  },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.base,
  },
  emptyTitle: {
    ...type$.titleMd,
    color: colors.ink,
    marginBottom: space.xs,
  },
  emptyBody: {
    ...type$.bodyMd,
    color: colors.body,
    textAlign: "center",
    maxWidth: 320,
  },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: {
    ...type$.bodyMd,
    color: colors.body,
    marginBottom: space.base,
    textAlign: "center",
  },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: 999,
  },
  ctaText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },
  hero: {
    alignItems: "center",
    paddingTop: space.lg,
    paddingBottom: space.base,
    paddingHorizontal: space.lg,
  },
  heroLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  heroAmount: {
    fontSize: 38,
    fontWeight: "600",
    color: colors.ink,
    marginBottom: space.xs,
  },
  heroMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  heroMetaText: { ...type$.bodySm, color: colors.body },
  heroMetaTextMuted: { ...type$.bodySm, color: colors.muted },
  heroDot: {
    width: 3,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.mutedSoft,
  },
  section: {
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
  },
  sectionTitle: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: space.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: space.sm,
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  glyph: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, minWidth: 0 },
  rowTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowNote: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  rowRight: { alignItems: "flex-end" },
  rowAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowDate: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
});
