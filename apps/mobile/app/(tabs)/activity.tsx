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
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO, TransactionDTO, Cadence } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { formatMoney, dateBucket } from "../../src/format/money";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { categoryMeta } from "../../src/categories/meta";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";
import { type DateRange } from "../../src/datetime/DateRangeSheet";
import { useDateRangeSheet } from "../../src/datetime/DateRangeSheetHost";
import { ConnectBankButton } from "../../src/plaid/ConnectBankButton";

const HEADER_HEIGHT = 72;

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

type Section = { title: string; data: TransactionDTO[] };

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
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();

  let total = 0;
  let count = 0;
  for (const s of schedules) {
    const d = parseDateOnly(s.scheduledDate);
    if (
      d.getUTCFullYear() === year &&
      d.getUTCMonth() === month &&
      d >= today
    ) {
      total += Number(s.amount);
      count += 1;
    }
  }
  for (const r of subscriptions) {
    for (const ymd of r.remainingThisMonth) {
      const d = parseDateOnly(ymd);
      if (
        d.getUTCFullYear() === year &&
        d.getUTCMonth() === month &&
        d >= today
      ) {
        total += Number(r.amount);
        count += 1;
      }
    }
  }
  return { total, count };
}

function groupByDate(txs: TransactionDTO[]): Section[] {
  const buckets = new Map<string, TransactionDTO[]>();
  for (const t of txs) {
    const key = dateBucket(t.occurredAt);
    const arr = buckets.get(key) ?? [];
    arr.push(t);
    buckets.set(key, arr);
  }
  return Array.from(buckets, ([title, data]) => ({ title, data }));
}

function sectionTotal(txs: TransactionDTO[], currency: string): string {
  const sum = txs.reduce((acc, t) => acc + Number(t.amount), 0);
  const { display, isIncome } = formatMoney(sum.toString(), currency);
  return `${isIncome ? "+" : "−"}${display}`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", hour12: false });
}

export default function Activity() {
  const [txs, setTxs] = useState<TransactionDTO[] | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [upcoming, setUpcoming] = useState<UpcomingSummary>({
    total: 0,
    count: 0,
  });
  const [wsId, setWsId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<DateRange>({});
  const dateRangeSheet = useDateRangeSheet();
  // Mirror query + range into refs so load() can always read the latest
  // values without putting them in its closure (keeps useFocusEffect
  // deps stable across renders).
  const queryRef = useRef("");
  const rangeRef = useRef<DateRange>({});
  queryRef.current = query;
  rangeRef.current = range;
  const insets = useSafeAreaInsets();
  const totalHeader = insets.top + HEADER_HEIGHT;
  const header = useCollapsingHeader(HEADER_HEIGHT);

  const load = useCallback(async () => {
    try {
      const id = (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!id) {
        setErr("no_workspace");
        return;
      }
      setWsId(id);
      const trimmed = queryRef.current.trim();
      const r = rangeRef.current;
      const params = new URLSearchParams({ limit: "100" });
      if (trimmed) params.set("q", trimmed);
      if (r.from) params.set("from", r.from);
      if (r.to) params.set("to", r.to);
      const qs = `?${params.toString()}`;
      const [txResp, catResp, schedResp, recurResp] = await Promise.all([
        apiFetch<TxListResp>(`/workspaces/${id}/transactions${qs}`),
        apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${id}/categories`),
        apiFetch<{ schedules: Schedule[] }>(
          `/workspaces/${id}/schedules?status=upcoming`,
        ).catch(() => ({ schedules: [] as Schedule[] })),
        apiFetch<{ recurring: Recurring[] }>(
          `/workspaces/${id}/recurring`,
        ).catch(() => ({ recurring: [] as Recurring[] })),
      ]);
      setTxs(txResp.transactions);
      setCategories(Object.fromEntries(catResp.categories.map((c) => [c.id, c])));
      setUpcoming(
        computeUpcomingSummary(schedResp.schedules, recurResp.recurring),
      );
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

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

  // Date-range changes reload immediately (no debounce — preset taps
  // and Apply are discrete events, not a stream).
  useEffect(() => {
    load();
  }, [range, load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
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

  const sections = groupByDate(txs);
  const isSearching = query.trim().length > 0;

  // Pick a currency for section totals — Plaid items live in one
  // workspace and share its currency, so safe to read from first tx.
  const currency = txs[0]?.currency ?? "CAD";

  return (
    <View style={styles.safe}>
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        contentContainerStyle={[styles.listContent, { paddingTop: totalHeader }]}
        stickySectionHeadersEnabled={false}
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
          upcoming.count > 0 ? (
            <UpcomingBanner
              total={upcoming.total}
              count={upcoming.count}
              currency={currency}
            />
          ) : null
        }
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHead}>
            <Text style={styles.sectionHeadLabel}>{section.title}</Text>
            <Text style={styles.sectionHeadAmount}>
              {sectionTotal(section.data, currency)}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <TxRow tx={item} categories={categories} />
        )}
        ListEmptyComponent={
          isSearching ? (
            <View style={styles.empty}>
              <View style={styles.iconWrap}>
                <Ionicons name="search" size={32} color={colors.muted} />
              </View>
              <Text style={styles.emptyTitle}>No matches</Text>
              <Text style={styles.emptyBody}>
                No transactions matched "{query.trim()}".
              </Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <View style={styles.iconWrap}>
                <Ionicons
                  name="receipt-outline"
                  size={36}
                  color={colors.muted}
                />
              </View>
              <Text style={styles.emptyTitle}>No transactions yet</Text>
              <Text style={styles.emptyBody}>
                Connect a bank to import automatically, or add transactions
                manually.
              </Text>
              <ConnectBankButton onConnected={() => load()} />
            </View>
          )
        }
      />
      <Animated.View style={[styles.headerOverlay, { top: insets.top, height: HEADER_HEIGHT }, header.headerStyle]}>
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
                  <Ionicons
                    name="close-circle"
                    size={18}
                    color={colors.mutedSoft}
                  />
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
          <ActivityHeader
            onSearch={() => setSearchOpen(true)}
            onRange={() => dateRangeSheet.open(range, setRange)}
            rangeActive={!!(range.from || range.to)}
          />
        )}
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />

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
      style={({ pressed }) => [
        styles.banner,
        pressed && { opacity: 0.7 },
      ]}
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
      <Ionicons
        name="chevron-forward"
        size={14}
        color={colors.mutedSoft}
      />
    </Pressable>
  );
}

function ActivityHeader({
  onSearch,
  onRange,
  rangeActive,
}: {
  onSearch?: () => void;
  onRange?: () => void;
  rangeActive?: boolean;
} = {}) {
  return (
    <View style={styles.head}>
      <Text style={styles.title}>Activity</Text>
      <View style={styles.headActions}>
        <HeaderIconButton
          icon="calendar-outline"
          accessibilityLabel="Date range"
          {...(onRange ? { onPress: onRange } : {})}
          {...(rangeActive ? { color: colors.primary } : {})}
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
}: {
  tx: TransactionDTO;
  categories: Record<string, CategoryDTO>;
}) {
  const money = formatMoney(tx.amount, tx.currency);
  const isSplit = tx.allocations.length > 1;
  const firstAllocCat = tx.allocations[0]?.categoryId
    ? categories[tx.allocations[0].categoryId]
    : null;
  const merchant = tx.merchantNormalized || tx.merchantRaw || "—";
  const categoryLabel = isSplit
    ? "Split"
    : firstAllocCat?.name ?? "Uncategorized";
  const uncategorized = !isSplit && !firstAllocCat?.id;
  const meta = categoryMeta(firstAllocCat);
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
        <Text
          style={[styles.rowMeta, uncategorized && styles.rowMetaUncat]}
          numberOfLines={1}
        >
          {categoryLabel}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text
          style={[styles.rowAmount, money.isIncome && { color: colors.up }]}
        >
          {money.isIncome ? "+" : "−"}
          {money.display}
        </Text>
        <Text style={styles.rowTime}>{formatTime(tx.occurredAt)}</Text>
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
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl, paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4, textAlign: "center" },
  errBody: {
    ...type$.bodyMd, color: colors.body, textAlign: "center",
    maxWidth: 320, marginBottom: space.lg,
  },
  listContent: { padding: space.lg, paddingTop: space.sm },
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
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: space.base,
    marginBottom: 6,
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
    width: 36, height: 36, borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center", justifyContent: "center",
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
  rowMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
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
  rowTime: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },
});
