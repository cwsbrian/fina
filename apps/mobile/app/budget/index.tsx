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
import type { CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { formatMoney } from "../../src/format/money";
import { categoryMeta } from "../../src/categories/meta";

type Allocation = { categoryId: string; amount: number };

type Plan = {
  id: string;
  periodStart: string;
  totalAmount: string;
  categoryAllocations: Allocation[];
};

type CategorySpend = {
  categoryId: string;
  categoryName: string;
  spent: number;
};

type CurrentResp = {
  yearMonth: string;
  plan: Plan | null;
  spendByCategory: CategorySpend[];
  totalSpent: string;
};

export default function BudgetScreen() {
  const [data, setData] = useState<CurrentResp | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [resp, cats] = await Promise.all([
        apiFetch<CurrentResp>(`/workspaces/${wsId}/budget-plans/current`),
        apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${wsId}/categories`),
      ]);
      setData(resp);
      setCategories(Object.fromEntries(cats.categories.map((c) => [c.id, c])));
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
          <Text style={styles.errTitle}>Couldn't load budget</Text>
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
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (!data.plan) {
    // Empty state — no default budget set yet.
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          <View style={styles.iconWrap}>
            <Ionicons name="trending-down" size={36} color={colors.muted} />
          </View>
          <Text style={styles.emptyTitle}>No budget yet</Text>
          <Text style={styles.emptyBody}>
            Set a monthly total — Fina will track your spend against it and
            (optionally) help you split it across categories.
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.cta,
              pressed && { opacity: 0.85 },
            ]}
            onPress={() => router.push("/budget/new" as never)}
          >
            <Text style={styles.ctaText}>Create a budget</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const total = Number(data.plan.totalAmount);
  const spent = Number(data.totalSpent);
  const remaining = total - spent;
  const pct = total > 0 ? Math.min(100, Math.round((spent / total) * 100)) : 0;
  const over = spent > total;

  // Merge plan allocations + spend per category. A category appears if
  // it has either a budget or actual spend.
  const planByCat = new Map(
    data.plan.categoryAllocations.map((a) => [a.categoryId, a.amount]),
  );
  const spendByCat = new Map(
    data.spendByCategory.map((s) => [s.categoryId, s]),
  );
  const allCatIds = new Set([
    ...planByCat.keys(),
    ...spendByCat.keys(),
  ]);
  const rows = Array.from(allCatIds, (id) => {
    const budget = planByCat.get(id) ?? 0;
    const sp = spendByCat.get(id);
    const cat = categories[id];
    return {
      categoryId: id,
      categoryName: sp?.categoryName ?? cat?.name ?? "Uncategorized",
      cat: cat ?? null,
      budget,
      spent: sp?.spent ?? 0,
    };
  }).sort((a, b) => {
    // Over-budget first, then by spend descending.
    const ao = a.budget > 0 && a.spent > a.budget ? 1 : 0;
    const bo = b.budget > 0 && b.spent > b.budget ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return b.spent - a.spent;
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header
        onEdit={() => router.push("/budget/new" as never)}
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
        {/* Total hero */}
        <View style={styles.hero}>
          <Text style={styles.heroLabel}>{monthLabel(data.yearMonth)}</Text>
          <Text style={[styles.heroAmount, over && { color: colors.down }]}>
            {formatMoney(spent.toFixed(2)).display}
          </Text>
          <Text style={styles.heroOf}>
            of {formatMoney(data.plan.totalAmount).display}
          </Text>
          <View style={styles.bar}>
            <View
              style={[
                styles.barFill,
                {
                  width: `${pct}%`,
                  backgroundColor: over ? colors.down : colors.primary,
                },
              ]}
            />
          </View>
          <View style={styles.heroFoot}>
            <Text style={styles.heroFootText}>{pct}%</Text>
            <Text
              style={[
                styles.heroFootText,
                over && { color: colors.down, fontWeight: "600" },
              ]}
            >
              {over
                ? `${formatMoney(Math.abs(remaining).toFixed(2)).display} over`
                : `${formatMoney(remaining.toFixed(2)).display} left`}
            </Text>
          </View>
        </View>

        {/* Per-category */}
        {rows.length === 0 ? (
          <View style={styles.noCats}>
            <Text style={styles.noCatsText}>
              No category breakdown yet. Add one anytime by editing the budget.
            </Text>
          </View>
        ) : (
          <View style={styles.list}>
            {rows.map((r) => (
              <CategoryRow key={r.categoryId} row={r} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function CategoryRow({
  row,
}: {
  row: {
    categoryId: string;
    categoryName: string;
    cat: CategoryDTO | null;
    budget: number;
    spent: number;
  };
}) {
  const meta = categoryMeta(row.cat);
  const hasBudget = row.budget > 0;
  const pct = hasBudget
    ? Math.min(100, Math.round((row.spent / row.budget) * 100))
    : 0;
  const over = hasBudget && row.spent > row.budget;
  const remaining = row.budget - row.spent;
  return (
    <View style={styles.catRow}>
      <View style={styles.catTop}>
        <View style={[styles.catGlyph, { backgroundColor: meta.bg }]}>
          <Ionicons name={meta.icon} size={16} color={meta.fg} />
        </View>
        <Text style={styles.catName}>{row.categoryName}</Text>
        <Text style={styles.catAmount}>
          {formatMoney(row.spent.toFixed(2)).display}
          {hasBudget && (
            <Text style={styles.catAmountOf}>
              {" "}/ {formatMoney(row.budget.toFixed(2)).display}
            </Text>
          )}
        </Text>
      </View>
      {hasBudget ? (
        <>
          <View style={styles.catBar}>
            <View
              style={[
                styles.catBarFill,
                {
                  width: `${pct}%`,
                  backgroundColor: over ? colors.down : meta.fg,
                },
              ]}
            />
          </View>
          <Text
            style={[
              styles.catRemaining,
              over && { color: colors.down, fontWeight: "600" },
            ]}
          >
            {over
              ? `${formatMoney(Math.abs(remaining).toFixed(2)).display} over`
              : `${formatMoney(remaining.toFixed(2)).display} left`}
          </Text>
        </>
      ) : (
        <Text style={styles.catRemaining}>No cap set</Text>
      )}
    </View>
  );
}

function Header({ onEdit }: { onEdit?: () => void } = {}) {
  return (
    <View style={styles.nav}>
      <HeaderIconButton
        icon="chevron-back"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        variant="plain"
      />
      <Text style={styles.navTitle}>Budget</Text>
      {onEdit ? (
        <HeaderIconButton
          icon="create-outline"
          accessibilityLabel="Edit budget"
          onPress={onEdit}
          variant="plain"
        />
      ) : (
        <View style={{ width: 34 }} />
      )}
    </View>
  );
}

function monthLabel(yearMonth: string): string {
  const [yStr, mStr] = yearMonth.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return yearMonth;
  const d = new Date(Date.UTC(y, m - 1, 1));
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
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
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base, textAlign: "center" },
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

  // Total hero
  hero: { padding: space.lg, alignItems: "center" },
  heroLabel: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  heroAmount: {
    fontSize: 44,
    fontWeight: "500",
    letterSpacing: -1.4,
    color: colors.ink,
  },
  heroOf: { ...type$.bodyMd, color: colors.muted, marginTop: 4, marginBottom: space.base },
  bar: {
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
    alignSelf: "stretch",
  },
  barFill: { height: "100%", borderRadius: 999 },
  heroFoot: {
    alignSelf: "stretch",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  heroFootText: { ...type$.bodySm, color: colors.muted },

  // Category list
  list: { paddingHorizontal: space.lg, gap: space.base },
  catRow: {
    paddingVertical: space.sm + 2,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  catTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    marginBottom: 8,
  },
  catGlyph: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  catName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", flex: 1 },
  catAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  catAmountOf: { color: colors.muted, fontWeight: "400" },
  catBar: {
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
    marginBottom: 4,
  },
  catBarFill: { height: "100%", borderRadius: 999 },
  catRemaining: { ...type$.bodySm, color: colors.muted },

  noCats: {
    padding: space.lg,
    alignItems: "center",
  },
  noCatsText: {
    ...type$.bodySm,
    color: colors.muted,
    textAlign: "center",
  },
});
