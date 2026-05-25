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
import type { CategoryDTO, GoalDTO } from "@fina/shared";
import { goalAccent } from "../../src/goals/meta";
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
  scheduledByCategory?: CategorySpend[];
  totalScheduled?: string;
};

type Data = {
  current: CurrentResp;
  defaultPlan: Plan | null;
};

function formatDelta(amount: number): string {
  const sign = amount > 0 ? "+" : "−";
  const abs = Math.abs(amount);
  return `${sign}${formatMoney(abs.toFixed(2)).display}`;
}

type GoalChip = {
  goalId: string;
  goalTitle: string;
  color: string;
  monthlyAmount: number;
};

export default function BudgetScreen() {
  const [data, setData] = useState<Data | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [goalsByCategory, setGoalsByCategory] = useState<
    Record<string, GoalChip[]>
  >({});
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [resp, cats, def, goalsResp] = await Promise.all([
        apiFetch<CurrentResp>(`/workspaces/${wsId}/budget-plans/current`),
        apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${wsId}/categories`),
        apiFetch<{ plan: Plan | null }>(
          `/workspaces/${wsId}/budget-plans/default`,
        ),
        apiFetch<{ goals: GoalDTO[] }>(`/workspaces/${wsId}/goals`).catch(
          () => ({ goals: [] as GoalDTO[] }),
        ),
      ]);
      setData({ current: resp, defaultPlan: def.plan });
      setCategories(Object.fromEntries(cats.categories.map((c) => [c.id, c])));
      // Build categoryId → goal chips map. Active goals only (archived
      // already filtered server-side). Each chip carries the goal's
      // accent color so the budget row can render it consistently.
      const byCat: Record<string, GoalChip[]> = {};
      for (const g of goalsResp.goals) {
        const accent = goalAccent({ color: g.color });
        for (const a of g.allocations) {
          const arr = byCat[a.categoryId] ?? [];
          arr.push({
            goalId: g.id,
            goalTitle: g.title,
            color: accent,
            monthlyAmount: Number(a.monthlyAmount),
          });
          byCat[a.categoryId] = arr;
        }
      }
      setGoalsByCategory(byCat);
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

  if (!data.current.plan) {
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

  const total = Number(data.current.plan.totalAmount);
  const spent = Number(data.current.totalSpent);
  const scheduled = Number(data.current.totalScheduled ?? "0");
  // Roll up goal allocations by goal across every category so each goal
  // gets a single colored segment on the hero bar (chips below already
  // show per-category breakdown).
  const goalTotalsById = new Map<
    string,
    { goalId: string; color: string; amount: number }
  >();
  for (const chips of Object.values(goalsByCategory)) {
    for (const c of chips) {
      const cur =
        goalTotalsById.get(c.goalId) ?? {
          goalId: c.goalId,
          color: c.color,
          amount: 0,
        };
      cur.amount += c.monthlyAmount;
      goalTotalsById.set(c.goalId, cur);
    }
  }
  const goalsTotal = Array.from(goalTotalsById.values()).reduce(
    (s, g) => s + g.amount,
    0,
  );
  const remaining = total - spent - scheduled;
  const pct = total > 0 ? Math.min(100, Math.round((spent / total) * 100)) : 0;
  const scheduledPct =
    total > 0
      ? Math.max(0, Math.min(100 - pct, (scheduled / total) * 100))
      : 0;
  // Each goal claims its own bar slice in priority order (largest first)
  // — clamped to the remaining cap space so segments don't run off.
  const goalSegments: Array<{ goalId: string; color: string; pct: number }> = [];
  if (total > 0) {
    let used = pct + scheduledPct;
    const ordered = Array.from(goalTotalsById.values()).sort(
      (a, b) => b.amount - a.amount,
    );
    for (const g of ordered) {
      const want = (g.amount / total) * 100;
      const allowed = Math.max(0, Math.min(100 - used, want));
      if (allowed <= 0) break;
      goalSegments.push({ goalId: g.goalId, color: g.color, pct: allowed });
      used += allowed;
    }
  }
  const over = spent > total;
  const willExceed = !over && spent + scheduled > total;

  // Compare against the default to surface this-month overrides.
  const defaultTotal = data.defaultPlan
    ? Number(data.defaultPlan.totalAmount)
    : null;
  const totalDiff =
    defaultTotal !== null && defaultTotal !== total ? total - defaultTotal : 0;

  // Merge plan allocations + spend per category. A category appears if
  // it has either a budget or actual spend.
  const planByCat = new Map(
    data.current.plan.categoryAllocations.map((a) => [a.categoryId, a.amount]),
  );
  const defaultByCat = new Map(
    (data.defaultPlan?.categoryAllocations ?? []).map(
      (a) => [a.categoryId, a.amount] as const,
    ),
  );
  const spendByCat = new Map(
    data.current.spendByCategory.map((s) => [s.categoryId, s]),
  );
  const schedByCat = new Map(
    (data.current.scheduledByCategory ?? []).map((s) => [s.categoryId, s]),
  );
  const allCatIds = new Set([
    ...planByCat.keys(),
    ...spendByCat.keys(),
    ...schedByCat.keys(),
  ]);
  const rows = Array.from(allCatIds, (id) => {
    const budget = planByCat.get(id) ?? 0;
    const defBudget = defaultByCat.get(id) ?? null;
    const sp = spendByCat.get(id);
    const sc = schedByCat.get(id);
    const cat = categories[id];
    return {
      categoryId: id,
      categoryName:
        sp?.categoryName ?? sc?.categoryName ?? cat?.name ?? "Uncategorized",
      cat: cat ?? null,
      budget,
      defaultBudget: defBudget,
      spent: sp?.spent ?? 0,
      scheduled: sc?.spent ?? 0,
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
          <Text style={styles.heroLabel}>{monthLabel(data.current.yearMonth)}</Text>
          <Text style={[styles.heroAmount, over && { color: colors.down }]}>
            {formatMoney(spent.toFixed(2)).display}
          </Text>
          <Text style={styles.heroOf}>
            of {formatMoney(data.current.plan.totalAmount).display}
          </Text>
          {totalDiff !== 0 && defaultTotal !== null && (
            <View style={styles.deltaPill}>
              <Ionicons
                name={totalDiff > 0 ? "arrow-up" : "arrow-down"}
                size={12}
                color={colors.muted}
              />
              <Text style={styles.deltaPillText}>
                {formatDelta(totalDiff)} vs default ({formatMoney(defaultTotal.toFixed(2)).display})
              </Text>
            </View>
          )}
          <View style={styles.bar}>
            <View style={styles.barRow}>
              <View
                style={[
                  styles.barSeg,
                  {
                    width: `${pct}%`,
                    backgroundColor: over ? colors.down : colors.primary,
                  },
                ]}
              />
              {scheduledPct > 0 && (
                <View
                  style={[
                    styles.barSeg,
                    {
                      width: `${scheduledPct}%`,
                      backgroundColor: willExceed
                        ? colors.down
                        : colors.primary,
                      opacity: 0.3,
                    },
                  ]}
                />
              )}
              {goalSegments.map((g) => (
                <View
                  key={g.goalId}
                  style={[
                    styles.barSeg,
                    {
                      width: `${g.pct}%`,
                      backgroundColor: g.color,
                      opacity: 0.7,
                    },
                  ]}
                />
              ))}
            </View>
          </View>
          <View style={styles.heroFoot}>
            <Text style={styles.heroFootText}>{pct}%</Text>
            <Text
              style={[
                styles.heroFootText,
                (over || willExceed) && {
                  color: colors.down,
                  fontWeight: "600",
                },
              ]}
            >
              {remaining < 0
                ? `${formatMoney(Math.abs(remaining).toFixed(2)).display} over`
                : `${formatMoney(remaining.toFixed(2)).display} left`}
            </Text>
          </View>
          {scheduled > 0 && (
            <Text style={styles.heroScheduled}>
              + {formatMoney(scheduled.toFixed(2)).display} scheduled this month
            </Text>
          )}
          {goalsTotal > 0 && (
            <Text style={styles.heroGoals}>
              + {formatMoney(goalsTotal.toFixed(2)).display} reserved for goals
            </Text>
          )}
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
              <CategoryRow
                key={r.categoryId}
                row={r}
                goals={goalsByCategory[r.categoryId] ?? []}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function CategoryRow({
  row,
  goals,
}: {
  row: {
    categoryId: string;
    categoryName: string;
    cat: CategoryDTO | null;
    budget: number;
    defaultBudget: number | null;
    spent: number;
    scheduled: number;
  };
  goals: GoalChip[];
}) {
  const meta = categoryMeta(row.cat);
  const hasBudget = row.budget > 0;
  const goalsSum = goals.reduce((s, g) => s + g.monthlyAmount, 0);
  const pct = hasBudget
    ? Math.min(100, Math.round((row.spent / row.budget) * 100))
    : 0;
  const schedPct =
    hasBudget && row.scheduled > 0
      ? Math.max(
          0,
          Math.min(100 - pct, (row.scheduled / row.budget) * 100),
        )
      : 0;
  // Per-goal bar segments in their own colors. Same cascade rule:
  // each segment claims its own slice up to what's left of the cap.
  const goalSegs: Array<{ goalId: string; color: string; pct: number }> = [];
  if (hasBudget && goalsSum > 0) {
    let used = pct + schedPct;
    const ordered = [...goals].sort((a, b) => b.monthlyAmount - a.monthlyAmount);
    for (const g of ordered) {
      const want = (g.monthlyAmount / row.budget) * 100;
      const allowed = Math.max(0, Math.min(100 - used, want));
      if (allowed <= 0) break;
      goalSegs.push({ goalId: g.goalId, color: g.color, pct: allowed });
      used += allowed;
    }
  }
  const over = hasBudget && row.spent > row.budget;
  const remaining = row.budget - row.spent - row.scheduled;
  const willExceed = hasBudget && !over && row.spent + row.scheduled > row.budget;
  const diff =
    row.defaultBudget !== null && row.defaultBudget !== row.budget
      ? row.budget - row.defaultBudget
      : 0;
  return (
    <View style={styles.catRow}>
      <View style={styles.catTop}>
        <View style={[styles.catGlyph, { backgroundColor: meta.bg }]}>
          <Ionicons name={meta.icon} size={16} color={meta.fg} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.catName} numberOfLines={1}>
            {row.categoryName}
          </Text>
          {diff !== 0 && (
            <Text style={styles.catDelta}>
              {formatDelta(diff)} vs default
            </Text>
          )}
        </View>
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
            <View style={styles.catBarRow}>
              <View
                style={[
                  styles.catBarSeg,
                  {
                    width: `${pct}%`,
                    backgroundColor: over ? colors.down : meta.fg,
                  },
                ]}
              />
              {schedPct > 0 && (
                <View
                  style={[
                    styles.catBarSeg,
                    {
                      width: `${schedPct}%`,
                      backgroundColor: willExceed ? colors.down : meta.fg,
                      opacity: 0.35,
                    },
                  ]}
                />
              )}
              {goalSegs.map((g) => (
                <View
                  key={g.goalId}
                  style={[
                    styles.catBarSeg,
                    {
                      width: `${g.pct}%`,
                      backgroundColor: g.color,
                      opacity: 0.7,
                    },
                  ]}
                />
              ))}
            </View>
          </View>
          <View style={styles.catFoot}>
            <Text
              style={[
                styles.catRemaining,
                (over || willExceed) && {
                  color: colors.down,
                  fontWeight: "600",
                },
              ]}
            >
              {remaining < 0
                ? `${formatMoney(Math.abs(remaining).toFixed(2)).display} over`
                : `${formatMoney(remaining.toFixed(2)).display} left`}
            </Text>
            {row.scheduled > 0 && (
              <Text style={styles.catScheduled}>
                + {formatMoney(row.scheduled.toFixed(2)).display} scheduled
              </Text>
            )}
          </View>
        </>
      ) : row.scheduled > 0 ? (
        <Text style={styles.catRemaining}>
          + {formatMoney(row.scheduled.toFixed(2)).display} scheduled · no cap set
        </Text>
      ) : (
        <Text style={styles.catRemaining}>No cap set</Text>
      )}
      {goals.length > 0 && (
        <View style={styles.goalChips}>
          {goals.map((g) => (
            <View
              key={g.goalId}
              style={[styles.goalChip, { borderColor: g.color }]}
            >
              <View style={[styles.goalChipDot, { backgroundColor: g.color }]} />
              <Text
                style={[styles.goalChipText, { color: g.color }]}
                numberOfLines={1}
              >
                {g.goalTitle} ${g.monthlyAmount.toFixed(0)}
              </Text>
            </View>
          ))}
        </View>
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
  heroOf: { ...type$.bodyMd, color: colors.muted, marginTop: 4 },
  deltaPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.surfaceSoft,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    marginTop: 8,
    marginBottom: space.sm,
  },
  deltaPillText: { ...type$.bodySm, color: colors.muted },
  bar: {
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
    alignSelf: "stretch",
  },
  barRow: { height: "100%", flexDirection: "row" },
  barSeg: { height: "100%" },
  heroFoot: {
    alignSelf: "stretch",
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  heroFootText: { ...type$.bodySm, color: colors.muted },
  heroScheduled: {
    ...type$.bodySm,
    color: colors.muted,
    alignSelf: "flex-end",
    marginTop: 2,
  },
  heroGoals: {
    ...type$.bodySm,
    color: colors.muted,
    alignSelf: "flex-end",
    marginTop: 2,
  },

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
  catName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  catDelta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  catAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  catAmountOf: { color: colors.muted, fontWeight: "400" },
  catBar: {
    height: 6,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
    marginBottom: 4,
  },
  catBarRow: { height: "100%", flexDirection: "row" },
  catBarSeg: { height: "100%" },
  catFoot: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
  },
  catRemaining: { ...type$.bodySm, color: colors.muted },
  catScheduled: { ...type$.bodySm, color: colors.muted },
  goalChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 6,
  },
  goalChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
  },
  goalChipDot: { width: 5, height: 5, borderRadius: 999 },
  goalChipText: { ...type$.caption, fontWeight: "600", maxWidth: 140 },

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
