import { useCallback, useState } from "react";
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
import { Stack, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO, Cadence } from "@fina/shared";
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

type Recurring = {
  id: string;
  name: string;
  amount: string;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId: string | null;
  categoryName: string | null;
  remainingThisMonth: string[];
};

type MergedItem = {
  key: string;
  source: "schedule" | "subscription";
  /** The backing row's id. For schedules: ScheduledSpend.id. For
   *  subscriptions: RecurringExpense.id (shared across all expanded
   *  occurrences — they all link to the same subscription detail). */
  sourceId: string;
  categoryId: string | null;
  categoryName: string | null;
  amount: string;
  scheduledDate: string;
  /** For schedules: user note. For subscriptions: subscription name. */
  note: string | null;
};

type Bucket = {
  key: "thisWeek" | "thisMonth" | "nextMonth" | "later";
  label: string;
  rows: MergedItem[];
};

function parseDateOnly(s: string): Date {
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

function bucketize(items: MergedItem[]): Bucket[] {
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

  for (const s of items) {
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

function buildMerged(
  schedules: Schedule[],
  subscriptions: Recurring[],
): MergedItem[] {
  const out: MergedItem[] = [];
  for (const s of schedules) {
    out.push({
      key: `s:${s.id}`,
      source: "schedule",
      sourceId: s.id,
      categoryId: s.categoryId,
      categoryName: null,
      amount: s.amount,
      scheduledDate: s.scheduledDate,
      note: s.note,
    });
  }
  // Subscriptions: expand this-month-remaining dates. Each occurrence
  // is its own merged row so it sits in the right date bucket.
  for (const r of subscriptions) {
    for (const ymd of r.remainingThisMonth) {
      out.push({
        key: `r:${r.id}:${ymd}`,
        source: "subscription",
        sourceId: r.id,
        categoryId: r.categoryId,
        categoryName: r.categoryName,
        amount: r.amount,
        scheduledDate: ymd,
        note: r.name,
      });
    }
  }
  out.sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
  return out;
}

export default function ScheduledScreen() {
  const [data, setData] = useState<{
    schedules: Schedule[];
    subscriptions: Recurring[];
  } | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [list, recur, cats] = await Promise.all([
        apiFetch<{ schedules: Schedule[] }>(
          `/workspaces/${wsId}/schedules?status=upcoming`,
        ),
        apiFetch<{ recurring: Recurring[] }>(
          `/workspaces/${wsId}/recurring`,
        ),
        apiFetch<{ categories: CategoryDTO[] }>(
          `/workspaces/${wsId}/categories`,
        ),
      ]);
      setData({ schedules: list.schedules, subscriptions: recur.recurring });
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

  if (!data) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallbackLoading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const merged = buildMerged(data.schedules, data.subscriptions);

  if (merged.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header
          onAdd={() => router.push("/scheduled/new" as never)}
        />
        <View style={styles.fallback}>
          <View style={styles.iconWrap}>
            <Ionicons name="calendar-outline" size={36} color={colors.muted} />
          </View>
          <Text style={styles.emptyTitle}>Nothing scheduled</Text>
          <Text style={styles.emptyBody}>
            Plan a future spend so it shows up against your budget. Tap + to
            schedule one, or ask Fina in chat.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  // Hero: this-month-remaining total + count.
  const today = startOfDayUTC(new Date());
  const inThisMonth = merged.filter((m) => {
    const d = parseDateOnly(m.scheduledDate);
    return (
      d.getUTCFullYear() === today.getUTCFullYear() &&
      d.getUTCMonth() === today.getUTCMonth() &&
      d >= today
    );
  });
  const monthTotal = inThisMonth.reduce(
    (sum, m) => sum + Number(m.amount),
    0,
  );

  const buckets = bucketize(merged);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header onAdd={() => router.push("/scheduled/new" as never)} />
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
            {b.rows.map((m) => (
              <ScheduledRow
                key={m.key}
                item={m}
                category={
                  m.categoryId ? categories[m.categoryId] ?? null : null
                }
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function ScheduledRow({
  item,
  category,
}: {
  item: MergedItem;
  category: CategoryDTO | null;
}) {
  const meta = categoryMeta(category);
  const d = parseDateOnly(item.scheduledDate);
  const catName =
    category?.name ?? item.categoryName ?? "Uncategorized";
  const isSub = item.source === "subscription";
  const onPress = () => {
    if (isSub) {
      router.push(`/subscriptions/${item.sourceId}` as never);
    } else {
      router.push(`/scheduled/${item.sourceId}` as never);
    }
  };
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
      onPress={onPress}
    >
      <View style={[styles.glyph, { backgroundColor: meta.bg }]}>
        <Ionicons name={meta.icon} size={16} color={meta.fg} />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTitleRow}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {catName}
          </Text>
          {isSub && <SubBadge />}
        </View>
        {item.note && (
          <Text style={styles.rowNote} numberOfLines={1}>
            {item.note}
          </Text>
        )}
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowAmount}>
          −{formatMoney(item.amount).display}
        </Text>
        <Text style={styles.rowDate}>{formatDateLabel(d)}</Text>
      </View>
      <Ionicons
        name="chevron-forward"
        size={14}
        color={colors.mutedSoft}
        style={styles.chev}
      />
    </Pressable>
  );
}

function SubBadge() {
  return (
    <View style={styles.subBadge}>
      <Ionicons name="repeat" size={10} color={colors.primary} />
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
    padding: space.xl,
    paddingTop: space.xxl,
  },
  fallbackLoading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
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
  rowTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rowTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowNote: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  rowRight: { alignItems: "flex-end" },
  chev: { marginLeft: 4 },
  rowAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowDate: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  subBadge: {
    width: 18,
    height: 18,
    borderRadius: 999,
    backgroundColor: "rgba(62, 179, 139, 0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
});
