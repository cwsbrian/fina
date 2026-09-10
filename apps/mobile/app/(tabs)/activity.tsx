import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  SectionList,
  ActivityIndicator,
  RefreshControl,
  Animated,
  TextInput,
  Keyboard,
  ScrollView,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO, TransactionDTO, Cadence } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace, bootstrapActiveWorkspaceSummary } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { useWorkspaceCurrency } from "../../src/workspace/useWorkspaceCurrency";
import { formatMoney, dateBucket } from "../../src/format/money";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { categoryMeta } from "../../src/categories/meta";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";
import { type DateRange } from "../../src/datetime/DateRangeSheet";
import { ConnectBankButton } from "../../src/plaid/ConnectBankButton";
import { NeedsReviewDot } from "../../src/categorize/NeedsReviewPill";
import { getSeenExcludedIds } from "../../src/transactions/excludedSeen";
import {
  ACTIVITY_PAGE_LIMIT,
  buildActivityTransactionsPath,
  mergeActivityTransactionPages,
} from "../../src/activity/pagination";
import {
  UNCATEGORIZED_FILTER_ID,
  type ActivityDirectionFilter,
  type ActivityFilters,
} from "../../src/activity/CategoryFilterSheet";
import { prepareActivityFilterNavigation } from "../../src/activity/filter-navigation";

const HEADER_HEIGHT = 84;
const FILTER_BADGE_BAR_HEIGHT = 46;
const activityFiltersByWorkspace = new Map<string, ActivityFilters>();

type TxListResp = {
  transactions: TransactionDTO[];
  nextCursor: string | null;
};

type Schedule = {
  id: string;
  amount: string;
  scheduledDate: string;
};

type Recurring = {
  id: string;
  amount: string;
  cadence: Cadence;
  remainingThisMonth: string[];
};

type UpcomingSummary = { total: number; count: number };

type Section = {
  title: string;
  data: TransactionDTO[];
  monthLabel: string | null;
  monthTotal: number;
  midMonthLabel: string | null;
  midMonthTotal: number;
};

function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1));
}

/** Compute this-month-remaining total + count for the Activity banner.
 *  Mirrors the /scheduled screen's merge logic but only needs the
 *  aggregate, not the bucketed rows. */
function computeUpcomingSummary(
  schedules: Schedule[],
  subscriptions: Recurring[],
): UpcomingSummary {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();

  let total = 0;
  let count = 0;
  for (const s of schedules) {
    const d = parseDateOnly(s.scheduledDate);
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month && d >= today) {
      total += Number(s.amount);
      count += 1;
    }
  }
  for (const r of subscriptions) {
    for (const ymd of r.remainingThisMonth) {
      const d = parseDateOnly(ymd);
      if (d.getUTCFullYear() === year && d.getUTCMonth() === month && d >= today) {
        total += Number(r.amount);
        count += 1;
      }
    }
  }
  return { total, count };
}

function groupByDate(txs: TransactionDTO[], direction: ActivityDirectionFilter): Section[] {
  const buckets = new Map<string, TransactionDTO[]>();
  const monthTotals = new Map<string, number>();
  const midMonthTotals = new Map<string, number>();
  for (const t of txs) {
    const key = dateBucket(t.occurredAt);
    const arr = buckets.get(key) ?? [];
    arr.push(t);
    buckets.set(key, arr);
    const month = monthKey(t.occurredAt);
    const amount = activitySummaryAmount(t, direction);
    if (month && amount > 0) {
      monthTotals.set(month, (monthTotals.get(month) ?? 0) + amount);
      if (dayOfMonth(t.occurredAt) <= 14) {
        midMonthTotals.set(month, (midMonthTotals.get(month) ?? 0) + amount);
      }
    }
  }
  let lastMonth = "";
  let lastDay = 32;
  const today = new Date();
  const currentMonth = monthKeyFromDate(today);
  return Array.from(buckets, ([title, data], index) => {
    const month = monthKey(data[0]?.occurredAt);
    const day = dayOfMonth(data[0]?.occurredAt);
    const isPastMonth = month !== "" && month !== currentMonth;
    const midPeriodPassed = isPastMonth || today.getDate() > 14;
    const monthLabel =
      isPastMonth && (index === 0 || month !== lastMonth)
        ? formatMonthLabel(data[0]?.occurredAt)
        : null;
    const midMonthLabel =
      month && midPeriodPassed && month === lastMonth && lastDay > 14 && day <= 14
        ? formatMidMonthLabel(data[0]?.occurredAt)
        : null;
    lastMonth = month || lastMonth;
    lastDay = day || lastDay;
    return {
      title,
      data,
      monthLabel,
      monthTotal: monthTotals.get(month) ?? 0,
      midMonthLabel,
      midMonthTotal: midMonthTotals.get(month) ?? 0,
    };
  });
}

function monthKey(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return monthKeyFromDate(date);
}

function monthKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function dayOfMonth(iso?: string): number {
  if (!iso) return 0;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 0;
  return date.getDate();
}

function formatMonthLabel(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-CA", { month: "long" });
}

function formatMidMonthLabel(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `Through ${date.toLocaleDateString("en-CA", { month: "short" })} 14`;
}

function sectionTotal(
  txs: TransactionDTO[],
  currency: string,
  direction: ActivityDirectionFilter,
): string {
  const sum = txs.reduce((acc, tx) => acc + activitySummaryAmount(tx, direction), 0);
  const { display } = formatMoney(sum.toString(), currency);
  return `${direction === "income" ? "+" : "−"}${display}`;
}

function effectiveExpenseAmount(tx: TransactionDTO): number {
  if (tx.budgetImpact !== "expense") return 0;
  return Math.max(0, Number(tx.amount) - Number(tx.refundedAmount));
}

function activitySummaryAmount(tx: TransactionDTO, direction: ActivityDirectionFilter): number {
  if (direction === "income") {
    return tx.budgetImpact === "income" ? Math.abs(Number(tx.amount)) : 0;
  }
  return effectiveExpenseAmount(tx);
}

function monthTotal(total: number, currency: string, direction: ActivityDirectionFilter): string {
  const { display } = formatMoney(total.toFixed(2), currency);
  return `${direction === "income" ? "+" : "−"}${display}`;
}

function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString(),
  };
}

export default function Activity() {
  const currency = useWorkspaceCurrency();
  const [txs, setTxs] = useState<TransactionDTO[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [upcoming, setUpcoming] = useState<UpcomingSummary>({
    total: 0,
    count: 0,
  });
  const [excludedCount, setExcludedCount] = useState(0);
  const [newExcludedCount, setNewExcludedCount] = useState(0);
  const [wsId, setWsId] = useState<string | null>(null);
  const [isBusiness, setIsBusiness] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [directionFilter, setDirectionFilter] = useState<ActivityDirectionFilter>("all");
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<DateRange>({});
  // Mirror query + range into refs so load() can always read the latest
  // values without putting them in its closure (keeps useFocusEffect
  // deps stable across renders).
  const queryRef = useRef("");
  const rangeRef = useRef<DateRange>({});
  const categoryFilterRef = useRef<string[]>([]);
  const directionFilterRef = useRef<ActivityDirectionFilter>("all");
  const filterWorkspaceRef = useRef<string | null>(null);
  queryRef.current = query;
  rangeRef.current = range;
  const hasCategoryFilter = selectedCategoryIds.length > 0;
  const hasDateFilter = !!(range.from || range.to);
  const hasDirectionFilter = directionFilter !== "all";
  const hasActiveFilters = hasCategoryFilter || hasDateFilter || hasDirectionFilter;
  const insets = useSafeAreaInsets();
  const currentHeaderHeight =
    HEADER_HEIGHT + (hasActiveFilters && !searchOpen ? FILTER_BADGE_BAR_HEIGHT : 0);
  const totalHeader = insets.top + currentHeaderHeight;
  const header = useCollapsingHeader(currentHeaderHeight);

  const load = useCallback(async () => {
    try {
      const workspace = await bootstrapActiveWorkspaceSummary();
      const id = workspace?.id ?? (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!id) {
        setErr("no_workspace");
        return;
      }
      if (filterWorkspaceRef.current !== id) {
        const savedFilter = activityFiltersByWorkspace.get(id) ?? {
          direction: "all" as const,
          range: {},
          selectedCategoryIds: [],
        };
        filterWorkspaceRef.current = id;
        categoryFilterRef.current = savedFilter.selectedCategoryIds;
        directionFilterRef.current = savedFilter.direction;
        rangeRef.current = savedFilter.range;
        setSelectedCategoryIds(savedFilter.selectedCategoryIds);
        setDirectionFilter(savedFilter.direction);
        setRange(savedFilter.range);
      }
      setWsId(id);
      setIsBusiness(workspace?.kind === "business");
      setNextCursor(null);
      setLoadingMore(false);
      const trimmed = queryRef.current.trim();
      const r = rangeRef.current;
      const txPath = buildActivityTransactionsPath({
        workspaceId: id,
        limit: ACTIVITY_PAGE_LIMIT,
        query: trimmed,
        range: r,
        categoryFilter: splitCategoryFilter(categoryFilterRef.current),
        ...(directionFilterRef.current === "all" ? {} : { direction: directionFilterRef.current }),
      });
      const excludedParams = new URLSearchParams({
        budgetImpact: "excluded",
        limit: String(ACTIVITY_PAGE_LIMIT),
        ...currentMonthRange(),
      });
      const [txResp, catResp, schedResp, recurResp, excludedResp, seenExcluded] = await Promise.all(
        [
          apiFetch<TxListResp>(txPath),
          apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${id}/categories`),
          apiFetch<{ schedules: Schedule[] }>(`/workspaces/${id}/schedules?status=upcoming`).catch(
            () => ({ schedules: [] as Schedule[] }),
          ),
          apiFetch<{ recurring: Recurring[] }>(`/workspaces/${id}/recurring`).catch(() => ({
            recurring: [] as Recurring[],
          })),
          apiFetch<TxListResp>(`/workspaces/${id}/transactions?${excludedParams.toString()}`).catch(
            () => ({ transactions: [], nextCursor: null }),
          ),
          getSeenExcludedIds(),
        ],
      );
      setTxs(mergeActivityTransactionPages([], txResp.transactions));
      setNextCursor(txResp.nextCursor);
      setExcludedCount(excludedResp.transactions.length);
      setNewExcludedCount(excludedResp.transactions.filter((t) => !seenExcluded.has(t.id)).length);
      setCategories(Object.fromEntries(catResp.categories.map((c) => [c.id, c])));
      setUpcoming(computeUpcomingSummary(schedResp.schedules, recurResp.recurring));
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
      setNextCursor(null);
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!wsId || !nextCursor || loadingMore || txs === null) return;
    setLoadingMore(true);
    try {
      const path = buildActivityTransactionsPath({
        workspaceId: wsId,
        limit: ACTIVITY_PAGE_LIMIT,
        cursor: nextCursor,
        query: queryRef.current.trim(),
        range: rangeRef.current,
        categoryFilter: splitCategoryFilter(categoryFilterRef.current),
        ...(directionFilterRef.current === "all" ? {} : { direction: directionFilterRef.current }),
      });
      const resp = await apiFetch<TxListResp>(path);
      setTxs((current) =>
        current === null
          ? mergeActivityTransactionPages([], resp.transactions)
          : mergeActivityTransactionPages(current, resp.transactions),
      );
      setNextCursor(resp.nextCursor);
    } catch {
      // Keep the current page intact. The next scroll can retry the same cursor.
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, txs, wsId]);

  // Reload every focus so deletions / edits on detail show fresh.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Debounced refetch on query change. 200ms is short enough to feel
  // live and long enough to skip mid-word fetches.
  useEffect(() => {
    const t = setTimeout(() => {
      load();
    }, 200);
    return () => clearTimeout(t);
  }, [query, load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const applyFilters = (filters: ActivityFilters) => {
    const nextCategories = [...new Set(filters.selectedCategoryIds)];
    const nextFilters = { ...filters, selectedCategoryIds: nextCategories };
    categoryFilterRef.current = nextCategories;
    directionFilterRef.current = filters.direction;
    rangeRef.current = filters.range;
    setSelectedCategoryIds(nextCategories);
    setDirectionFilter(filters.direction);
    setRange(filters.range);
    if (wsId) activityFiltersByWorkspace.set(wsId, nextFilters);
    load();
  };

  const clearFilters = () => {
    applyFilters({ direction: "all", range: {}, selectedCategoryIds: [] });
    header.reset();
  };

  const clearDirectionFilter = () => {
    applyFilters({ direction: "all", range, selectedCategoryIds });
    header.reset();
  };

  const clearDateFilter = () => {
    applyFilters({ direction: directionFilter, range: {}, selectedCategoryIds });
    header.reset();
  };

  const clearCategoryFilter = (categoryId: string) => {
    applyFilters({
      direction: directionFilter,
      range,
      selectedCategoryIds: selectedCategoryIds.filter((id) => id !== categoryId),
    });
    header.reset();
  };

  const openFilters = () => {
    prepareActivityFilterNavigation({
      filters: { direction: directionFilter, range, selectedCategoryIds },
      categories: Object.values(categories),
      onApply: (filters) => {
        applyFilters(filters);
        header.reset();
      },
    });
    router.push("/activity/filters" as never);
  };

  if (err && txs === null) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityHeader />
        <View style={styles.empty}>
          <Text style={styles.errTitle}>Couldn't load activity</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={() => load()}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (txs === null) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityHeader />
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const sections = groupByDate(txs, directionFilter);
  const isSearching = query.trim().length > 0;

  return (
    <View style={styles.safe}>
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        contentContainerStyle={[styles.listContent, { paddingTop: totalHeader }]}
        stickySectionHeadersEnabled={false}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
        onEndReached={loadMore}
        onEndReachedThreshold={0.35}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            progressViewOffset={totalHeader}
          />
        }
        ListHeaderComponent={
          <View>
            {upcoming.count > 0 ? (
              <UpcomingBanner total={upcoming.total} count={upcoming.count} currency={currency} />
            ) : null}
            {excludedCount > 0 ? <ExcludedBanner hasNew={newExcludedCount > 0} /> : null}
          </View>
        }
        renderSectionHeader={({ section }) => (
          <View>
            {section.monthLabel ? (
              <View style={styles.monthHead}>
                <Text style={styles.monthHeadLabel}>{section.monthLabel}</Text>
                <Text style={styles.monthHeadAmount}>
                  {monthTotal(section.monthTotal, currency, directionFilter)}
                </Text>
              </View>
            ) : null}
            {section.midMonthLabel ? (
              <View style={styles.midMonthHead}>
                <Text style={styles.midMonthHeadLabel}>{section.midMonthLabel}</Text>
                <Text style={styles.midMonthHeadAmount}>
                  {monthTotal(section.midMonthTotal, currency, directionFilter)}
                </Text>
              </View>
            ) : null}
            <View style={styles.sectionHead}>
              <Text style={styles.sectionHeadLabel}>{section.title}</Text>
              {section.data.length > 1 &&
                section.data.some((tx) => activitySummaryAmount(tx, directionFilter) > 0) && (
                  <Text style={styles.sectionHeadAmount}>
                    {sectionTotal(section.data, currency, directionFilter)}
                  </Text>
                )}
            </View>
          </View>
        )}
        renderItem={({ item }) => <TxRow tx={item} categories={categories} isBusiness={isBusiness} />}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footerLoading}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          hasActiveFilters ? (
            <View style={styles.empty}>
              <View style={styles.iconWrap}>
                <Ionicons name="funnel-outline" size={32} color={colors.muted} />
              </View>
              <Text style={styles.emptyTitle}>No matching transactions</Text>
              <Text style={styles.emptyBody}>No transactions match the selected filters.</Text>
              <Pressable
                style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
                onPress={clearFilters}
              >
                <Text style={styles.ctaText}>Clear filters</Text>
              </Pressable>
            </View>
          ) : isSearching ? (
            <View style={styles.empty}>
              <View style={styles.iconWrap}>
                <Ionicons name="search" size={32} color={colors.muted} />
              </View>
              <Text style={styles.emptyTitle}>No matches</Text>
              <Text style={styles.emptyBody}>No transactions matched "{query.trim()}".</Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <View style={styles.iconWrap}>
                <Ionicons name="receipt-outline" size={36} color={colors.muted} />
              </View>
              <Text style={styles.emptyTitle}>No transactions yet</Text>
              <Text style={styles.emptyBody}>
                Add one manually to get started. Bank sync is optional.
              </Text>
              <View style={styles.emptyActions}>
                <Pressable
                  style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
                  onPress={() => router.push("/transactions/new" as never)}
                >
                  <Text style={styles.ctaText}>Add transaction</Text>
                </Pressable>
                <ConnectBankButton
                  compact
                  label="Connect a bank (optional)"
                  onConnected={() => load()}
                />
              </View>
            </View>
          )
        }
      />
      <Animated.View
        style={[
          styles.headerOverlay,
          { top: insets.top, height: currentHeaderHeight },
          header.headerStyle,
        ]}
      >
        {searchOpen ? (
          <View style={styles.head}>
            <View style={styles.searchWrap}>
              <Ionicons name="search" size={16} color={colors.muted} />
              <TextInput
                style={styles.searchInput}
                placeholder="Search merchants"
                placeholderTextColor={colors.muted}
                value={query}
                onChangeText={setQuery}
                autoFocus
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType="search"
              />
              {query.length > 0 && (
                <Pressable
                  onPress={() => setQuery("")}
                  hitSlop={8}
                  style={({ pressed }) => pressed && { opacity: 0.6 }}
                >
                  <Ionicons name="close-circle" size={18} color={colors.mutedSoft} />
                </Pressable>
              )}
            </View>
            <Pressable
              onPress={() => {
                setSearchOpen(false);
                setQuery("");
                Keyboard.dismiss();
              }}
              hitSlop={8}
            >
              <Text style={styles.searchCancel}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <ActivityHeader
              onSearch={() => setSearchOpen(true)}
              onFilters={openFilters}
              filtersActive={hasActiveFilters}
              count={txs?.length}
            />
            {hasActiveFilters ? (
              <ActivityFilterBadges
                direction={directionFilter}
                range={range}
                selectedCategoryIds={selectedCategoryIds}
                categories={categories}
                onClearDirection={clearDirectionFilter}
                onClearDate={clearDateFilter}
                onClearCategory={clearCategoryFilter}
              />
            ) : null}
          </>
        )}
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />
    </View>
  );
}

function splitCategoryFilter(selectedIds: string[]) {
  return {
    categoryIds: selectedIds.filter((id) => id !== UNCATEGORIZED_FILTER_ID),
    includeUncategorized: selectedIds.includes(UNCATEGORIZED_FILTER_ID),
  };
}

function ActivityFilterBadges({
  direction,
  range,
  selectedCategoryIds,
  categories,
  onClearDirection,
  onClearDate,
  onClearCategory,
}: {
  direction: ActivityDirectionFilter;
  range: DateRange;
  selectedCategoryIds: string[];
  categories: Record<string, CategoryDTO>;
  onClearDirection: () => void;
  onClearDate: () => void;
  onClearCategory: (categoryId: string) => void;
}) {
  const dateBadge =
    range.from && range.to
      ? `${range.from} – ${range.to}`
      : range.from
        ? `From ${range.from}`
        : `Through ${range.to}`;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.filterBadgeBar}
      contentContainerStyle={styles.filterBadgeContent}
    >
      {direction !== "all" ? (
        <FilterBadge
          label={direction === "expense" ? "Expenses" : "Income"}
          onRemove={onClearDirection}
        />
      ) : null}
      {range.from || range.to ? <FilterBadge label={dateBadge} onRemove={onClearDate} /> : null}
      {selectedCategoryIds.map((id) => (
        <FilterBadge
          key={id}
          label={
            id === UNCATEGORIZED_FILTER_ID ? "Uncategorized" : (categories[id]?.name ?? "Category")
          }
          onRemove={() => onClearCategory(id)}
        />
      ))}
    </ScrollView>
  );
}

function FilterBadge({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <View style={styles.filterBadge}>
      <Text style={styles.filterBadgeText} numberOfLines={1}>
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${label} filter`}
        onPress={onRemove}
        hitSlop={8}
        style={({ pressed }) => pressed && { opacity: 0.55 }}
      >
        <Ionicons name="close" size={14} color={colors.primary} />
      </Pressable>
    </View>
  );
}

function UpcomingBanner({
  total,
  count,
  currency,
}: {
  total: number;
  count: number;
  currency: string;
}) {
  const { display } = formatMoney(total.toFixed(2), currency);
  return (
    <Pressable
      style={({ pressed }) => [styles.banner, pressed && { opacity: 0.7 }]}
      onPress={() => router.push("/scheduled" as never)}
    >
      <View style={styles.bannerGlyph}>
        <Ionicons name="calendar" size={13} color={colors.primary} />
      </View>
      <Text style={styles.bannerLabel} numberOfLines={1}>
        Upcoming this month
      </Text>
      <Text style={styles.bannerAmount}>−{display}</Text>
      <Text style={styles.bannerCount}>· {count}</Text>
      <Ionicons name="chevron-forward" size={14} color={colors.mutedSoft} />
    </Pressable>
  );
}

function ExcludedBanner({ hasNew }: { hasNew: boolean }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.banner, pressed && { opacity: 0.7 }]}
      onPress={() => router.push("/transactions/excluded" as never)}
    >
      <View style={styles.bannerGlyph}>
        <Ionicons name="eye-off-outline" size={13} color={colors.primary} />
      </View>
      <Text style={styles.bannerLabel} numberOfLines={1}>
        Excluded transactions
      </Text>
      {hasNew && <View style={styles.bannerDot} />}
      <Ionicons name="chevron-forward" size={14} color={colors.mutedSoft} />
    </Pressable>
  );
}

function ActivityHeader({
  onSearch,
  onFilters,
  filtersActive,
  count,
}: {
  onSearch?: () => void;
  onFilters?: () => void;
  filtersActive?: boolean;
  count?: number;
} = {}) {
  return (
    <View style={styles.head}>
      <View>
        <Text style={styles.title}>Activity</Text>
        <Text style={styles.subtitle}>
          {count !== undefined
            ? `${count.toLocaleString()} transaction${count === 1 ? "" : "s"}`
            : "All accounts"}
        </Text>
      </View>
      <View style={styles.headActions}>
        <HeaderIconButton
          icon="funnel-outline"
          accessibilityLabel="Filter transactions"
          {...(onFilters ? { onPress: onFilters } : {})}
          {...(filtersActive ? { color: colors.primary } : {})}
        />
        <HeaderIconButton
          icon="search-outline"
          accessibilityLabel="Search"
          {...(onSearch ? { onPress: onSearch } : {})}
        />
        <HeaderIconButton
          icon="add"
          size={22}
          accessibilityLabel="Add transaction"
          onPress={() => router.push("/transactions/new" as never)}
        />
      </View>
    </View>
  );
}

function TxRow({
  tx,
  categories,
  isBusiness,
}: {
  tx: TransactionDTO;
  categories: Record<string, CategoryDTO>;
  isBusiness: boolean;
}) {
  const money = formatMoney(tx.amount, tx.currency);
  const isSplit = tx.allocations.length > 1;
  const firstAlloc = tx.allocations[0];
  const firstAllocCat = firstAlloc?.categoryId ? categories[firstAlloc.categoryId] : null;
  const merchant = tx.merchantNormalized || tx.merchantRaw || "—";
  const categoryLabel = isSplit ? "Split" : (firstAllocCat?.name ?? "Uncategorized");
  const uncategorized = !isSplit && !firstAllocCat?.id;
  const meta = categoryMeta(firstAllocCat);
  // Needs-review dot: only on single-allocation rows with a categorized
  // allocation that needs confirmation. Visual only — row tap navigates
  // to the transaction detail where the confirm banner lives.
  const showDot = !isSplit && !!firstAlloc?.needsConfirmation && !!firstAllocCat;
  const isOther = !!firstAllocCat && firstAllocCat.name.trim().toLowerCase() === "other";
  const reviewedBusiness = tx.allocations.every((allocation) => allocation.businessAmount !== null);
  const businessAmount = reviewedBusiness
    ? tx.allocations.reduce((sum, allocation) => sum + Number(allocation.businessAmount ?? 0), 0)
    : null;
  const partial = businessAmount !== null && businessAmount > 0 && businessAmount < Math.abs(Number(tx.amount));
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
      onPress={() => router.push(`/transactions/${tx.id}` as never)}
    >
      <View style={[styles.rowGlyph, { backgroundColor: meta.bg }]}>
        <Ionicons name={meta.icon} size={18} color={meta.fg} />
      </View>
      <View style={styles.rowMid}>
        <View style={styles.rowMidTitle}>
          <Text style={styles.rowTitle} numberOfLines={1} ellipsizeMode="tail">
            {merchant}
          </Text>
          {tx.pending && (
            <View style={styles.pendingBadge}>
              <Text style={styles.pendingText}>Pending</Text>
            </View>
          )}
        </View>
        <View style={styles.rowMetaLine}>
          <Text style={[styles.rowMeta, uncategorized && styles.rowMetaUncat]} numberOfLines={1}>
            {isBusiness
              ? `${categoryLabel} · ${businessAmount === null ? "Expense review" : businessAmount === 0 ? "Not business" : `${partial ? "Partial · " : ""}${formatMoney(businessAmount.toFixed(2), tx.currency).display} business`}`
              : categoryLabel}
          </Text>
          {showDot && <NeedsReviewDot isOther={isOther} />}
        </View>
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.rowAmount, money.isIncome && styles.rowAmountIncome]}>
          {money.isIncome ? "+" : "−"}
          {money.display}
        </Text>
      </View>
    </Pressable>
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
  // Title pinned to a fixed top offset so its Y is identical whether
  // or not a subtitle is present below it. Action buttons override the
  // parent flex-start with alignSelf: center so they stay vertically
  // centered in the full header height.
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: 12,
    height: HEADER_HEIGHT,
  },
  title: { ...type$.titleLg, color: colors.ink },
  subtitle: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  headActions: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    gap: 6,
  },
  searchWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.base,
    height: 38,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    marginRight: space.sm,
  },
  searchInput: {
    flex: 1,
    ...type$.bodyMd,
    color: colors.ink,
    paddingVertical: 0,
  },
  searchCancel: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
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
  emptyActions: { alignItems: "center", gap: space.sm },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4, textAlign: "center" },
  errBody: {
    ...type$.bodyMd,
    color: colors.body,
    textAlign: "center",
    maxWidth: 320,
    marginBottom: space.lg,
  },
  listContent: { padding: space.lg, paddingTop: space.sm, flexGrow: 1 },
  filterBadgeBar: { height: FILTER_BADGE_BAR_HEIGHT },
  filterBadgeContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: space.lg,
    paddingBottom: 10,
  },
  filterBadge: {
    maxWidth: 240,
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingLeft: 11,
    paddingRight: 8,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  filterBadgeText: {
    ...type$.bodySm,
    color: colors.primary,
    fontWeight: "600",
    flexShrink: 1,
  },
  footerLoading: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: space.lg,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    marginTop: space.sm,
    marginBottom: 4,
  },
  bannerGlyph: {
    width: 24,
    height: 24,
    borderRadius: 999,
    backgroundColor: "rgba(62, 179, 139, 0.16)",
    alignItems: "center",
    justifyContent: "center",
  },
  bannerLabel: {
    ...type$.bodySm,
    color: colors.body,
    flex: 1,
  },
  bannerAmount: {
    ...type$.bodySm,
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  bannerCount: { ...type$.bodySm, color: colors.muted },
  bannerDot: { width: 8, height: 8, borderRadius: 999, backgroundColor: colors.primary },
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: space.base,
    marginBottom: 6,
  },
  monthHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: space.lg,
    marginHorizontal: -space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    backgroundColor: colors.surfaceSoft,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  monthHeadLabel: {
    ...type$.bodySm,
    color: colors.ink,
    fontWeight: "700",
  },
  monthHeadAmount: {
    ...type$.bodySm,
    color: colors.ink,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  midMonthHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: space.base,
    marginHorizontal: -space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: 7,
    backgroundColor: colors.canvas,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  midMonthHeadLabel: {
    ...type$.captionStrong,
    color: colors.muted,
  },
  midMonthHeadAmount: {
    ...type$.captionStrong,
    color: colors.muted,
    fontVariant: ["tabular-nums"],
  },
  sectionHeadLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
  },
  sectionHeadAmount: {
    ...type$.captionStrong,
    color: colors.muted,
    fontVariant: ["tabular-nums"],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingVertical: 10,
  },
  rowGlyph: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  // flex: 1 + minWidth: 0 lets the mid column shrink so the right
  // amount stays visible even when the merchant string is long.
  rowMid: { flex: 1, minWidth: 0 },
  // flexShrink: 1 on the row container + flex: 1 on the title Text are
  // both required for RN's flex layout to actually clip the text with
  // ellipsis; without flex: 1 the Text reports its full intrinsic width
  // and pushes the amount off-screen.
  rowMidTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
  },
  rowTitle: { ...type$.titleSm, color: colors.ink, flexShrink: 1, flex: 1 },
  rowMetaLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 2,
    flexShrink: 1,
  },
  rowMeta: { ...type$.bodySm, color: colors.muted, flexShrink: 1 },
  rowMetaUncat: { color: colors.accentYellow },
  pendingBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
  },
  pendingText: { ...type$.captionStrong, color: colors.muted, fontSize: 10 },
  rowRight: { alignItems: "flex-end" },
  rowAmount: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  rowAmountIncome: { color: colors.up },
});
