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
import type { CategoryDTO, Cadence } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { formatMoney } from "../../src/format/money";
import { categoryMeta } from "../../src/categories/meta";

type RecurringRow = {
  id: string;
  name: string;
  amount: string;
  currency: string;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId: string | null;
  categoryName: string | null;
  merchantNormalized: string | null;
  monthlyEquivalent: string;
  remainingThisMonth: string[];
  createdAt: string;
};

function cadenceLabel(c: Cadence): string {
  switch (c) {
    case "monthly":
      return "Monthly";
    case "semimonthly":
      return "Semi-monthly";
    case "biweekly":
      return "Bi-weekly";
    case "weekly":
      return "Weekly";
    case "yearly":
      return "Annual";
  }
}

function cadencePerLabel(c: Cadence): string {
  return c === "yearly" ? "/yr" : c === "weekly" ? "/wk" : "/mo";
}

function formatNextDate(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
  const now = new Date();
  const sameYear = date.getUTCFullYear() === now.getUTCFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  });
}

function formatSince(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

export default function SubscriptionsScreen() {
  const [rows, setRows] = useState<RecurringRow[] | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [list, cats] = await Promise.all([
        apiFetch<{ recurring: RecurringRow[] }>(
          `/workspaces/${wsId}/recurring`,
        ),
        apiFetch<{ categories: CategoryDTO[] }>(
          `/workspaces/${wsId}/categories`,
        ),
      ]);
      setRows(list.recurring);
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

  const onDelete = (row: RecurringRow) => {
    Alert.alert(
      `Remove ${row.name}?`,
      "This stops Fina from projecting future occurrences. Past matched transactions stay as-is.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            try {
              const wsId = await getActiveWorkspaceId();
              if (!wsId) return;
              await apiFetch(
                `/workspaces/${wsId}/recurring/${row.id}`,
                { method: "DELETE" },
              );
              load();
            } catch (e) {
              Alert.alert(
                "Couldn't remove",
                (e as { code?: string }).code ?? "error",
              );
            }
          },
        },
      ],
    );
  };

  if (err) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load subscriptions</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!rows) {
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

  if (rows.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header onAdd={() => router.push("/subscriptions/new" as never)} />
        <View style={styles.fallback}>
          <View style={styles.iconWrap}>
            <Ionicons name="repeat-outline" size={36} color={colors.muted} />
          </View>
          <Text style={styles.emptyTitle}>No subscriptions yet</Text>
          <Text style={styles.emptyBody}>
            Track Netflix, rent, Adobe — anything that bills on a schedule.
            Tap + to add one.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const monthlyTotal = rows.reduce(
    (s, r) => s + Number(r.monthlyEquivalent),
    0,
  );
  const yearlyTotal = monthlyTotal * 12;
  const hasNonMonthly = rows.some((r) => r.cadence !== "monthly");

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header onAdd={() => router.push("/subscriptions/new" as never)} />
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
          <Text style={styles.heroLabel}>Monthly average</Text>
          <Text style={styles.heroAmount}>
            {formatMoney(monthlyTotal.toFixed(2)).display}
            <Text style={styles.heroPer}>/mo</Text>
          </Text>
          <View style={styles.heroMeta}>
            <Text style={styles.heroMetaText}>
              {rows.length} active subscription{rows.length === 1 ? "" : "s"}
            </Text>
            <View style={styles.heroDot} />
            <Text style={styles.heroMetaText}>
              {formatMoney(yearlyTotal.toFixed(2)).display} / year
            </Text>
          </View>
          {hasNonMonthly && (
            <Text style={styles.heroNote}>
              Annual &amp; weekly subs are amortized to monthly
            </Text>
          )}
        </View>

        <Text style={styles.sectionTitle}>
          Active · {rows.length}
        </Text>
        {rows.map((r) => (
          <SubscriptionRow
            key={r.id}
            row={r}
            category={r.categoryId ? categories[r.categoryId] ?? null : null}
            onPress={() => router.push(`/subscriptions/${r.id}` as never)}
            onLongPress={() => onDelete(r)}
          />
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

function SubscriptionRow({
  row,
  category,
  onPress,
  onLongPress,
}: {
  row: RecurringRow;
  category: CategoryDTO | null;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const meta = categoryMeta(category);
  const cat = category?.name ?? row.categoryName ?? "Uncategorized";
  const showMonthlyEq = row.cadence !== "monthly";
  return (
    <Pressable
      style={({ pressed }) => [
        styles.subRow,
        pressed && { opacity: 0.7 },
      ]}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={400}
    >
      <View style={[styles.subGlyph, { backgroundColor: meta.bg }]}>
        <Ionicons name={meta.icon} size={18} color={meta.fg} />
      </View>
      <View style={styles.subBody}>
        <View style={styles.subTopRow}>
          <Text style={styles.subName} numberOfLines={1}>
            {row.name}
          </Text>
          <Text style={styles.subAmount}>
            {formatMoney(row.amount).display}
            <Text style={styles.subPer}>{cadencePerLabel(row.cadence)}</Text>
          </Text>
        </View>
        <View style={styles.subMetaRow}>
          <Text style={styles.subMetaText}>{cat}</Text>
          <View style={styles.subDot} />
          <Text style={styles.subMetaText}>{cadenceLabel(row.cadence)}</Text>
          {showMonthlyEq && (
            <>
              <View style={styles.subDot} />
              <Text style={styles.subMetaTextMuted}>
                ≈ {formatMoney(row.monthlyEquivalent).display}/mo
              </Text>
            </>
          )}
        </View>
        <View style={styles.subMetaRow}>
          <Text style={styles.subMetaTextSoft}>
            Next {formatNextDate(row.nextOccurrenceDate)}
          </Text>
          <View style={styles.subDot} />
          <Text style={styles.subMetaTextSoft}>
            Since {formatSince(row.createdAt)}
          </Text>
        </View>
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

function Header({ onAdd }: { onAdd?: () => void } = {}) {
  return (
    <View style={styles.nav}>
      <HeaderIconButton
        icon="chevron-back"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        variant="plain"
      />
      <Text style={styles.navTitle}>Subscriptions</Text>
      {onAdd ? (
        <HeaderIconButton
          icon="add"
          accessibilityLabel="Add subscription"
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
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginBottom: 6 },
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
  heroPer: { fontSize: 18, fontWeight: "500", color: colors.muted },
  heroMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
  },
  heroMetaText: { ...type$.bodySm, color: colors.body },
  heroDot: {
    width: 3,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.mutedSoft,
  },
  heroNote: {
    ...type$.bodySm,
    color: colors.muted,
    marginTop: space.sm,
    textAlign: "center",
  },
  sectionTitle: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },

  subRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
    gap: space.sm + 2,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  subGlyph: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  subBody: { flex: 1, minWidth: 0 },
  subTopRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  subName: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
    flex: 1,
    marginRight: space.sm,
  },
  subAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  subPer: { color: colors.muted, fontWeight: "400" },
  subMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 2,
  },
  subMetaText: { ...type$.bodySm, color: colors.body },
  subMetaTextMuted: { ...type$.bodySm, color: colors.muted },
  subMetaTextSoft: { ...type$.bodySm, color: colors.muted },
  subDot: {
    width: 3,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.mutedSoft,
  },
  chev: { marginLeft: 6 },
});
