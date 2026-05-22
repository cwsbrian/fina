import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  SectionList,
  ActivityIndicator,
  RefreshControl,
  Animated,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO, TransactionDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { formatMoney, dateBucket } from "../../src/format/money";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";

const HEADER_HEIGHT = 58;

type TxListResp = {
  transactions: TransactionDTO[];
  nextCursor: string | null;
};

type Section = { title: string; data: TransactionDTO[] };

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
  const [wsId, setWsId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const insets = useSafeAreaInsets();
  const totalHeader = insets.top + HEADER_HEIGHT;
  const header = useCollapsingHeader(totalHeader);

  const load = useCallback(async () => {
    try {
      const id = (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!id) {
        setErr("no_workspace");
        return;
      }
      setWsId(id);
      const [txResp, catResp] = await Promise.all([
        apiFetch<TxListResp>(`/workspaces/${id}/transactions?limit=100`),
        apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${id}/categories`),
      ]);
      setTxs(txResp.transactions);
      setCategories(Object.fromEntries(catResp.categories.map((c) => [c.id, c])));
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  // Reload every focus so a transaction edited elsewhere shows fresh.
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

  if (err && txs === null) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityHeader />
        <View style={styles.empty}>
          <Text style={styles.errTitle}>Couldn't load activity</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
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

  if (txs.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ActivityHeader />
        <View style={styles.empty}>
          <View style={styles.iconWrap}>
            <Ionicons name="receipt-outline" size={36} color={colors.muted} />
          </View>
          <Text style={styles.emptyTitle}>No transactions yet</Text>
          <Text style={styles.emptyBody}>
            Connect a bank to import automatically, or add transactions
            manually.
          </Text>
          <Pressable
            style={({ pressed }) => [styles.cta, pressed && { opacity: 0.85 }]}
            onPress={() => router.push("/(tabs)/more" as never)}
          >
            <Text style={styles.ctaText}>Connect a bank</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const sections = groupByDate(txs);

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
      />
      <Animated.View style={[styles.headerOverlay, { paddingTop: insets.top, height: totalHeader }, header.headerStyle]}>
        <ActivityHeader />
      </Animated.View>
    </View>
  );
}

function ActivityHeader() {
  return (
    <View style={styles.head}>
      <Text style={styles.title}>Activity</Text>
      <View style={styles.headActions}>
        <HeaderIconButton icon="calendar-outline" accessibilityLabel="Date range" />
        <HeaderIconButton icon="search-outline" accessibilityLabel="Search" />
        <HeaderIconButton icon="add" size={22} accessibilityLabel="Add" />
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
  return (
    <View style={styles.row}>
      <View style={styles.rowGlyph}>
        <Ionicons
          name={money.isIncome ? "trending-up" : "card-outline"}
          size={18}
          color={money.isIncome ? colors.up : colors.muted}
        />
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
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  headerOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
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
  headActions: { flexDirection: "row", alignItems: "center", gap: 6 },
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
