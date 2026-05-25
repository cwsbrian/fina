import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  SectionList,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO, TransactionDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../src/api/client";
import { getActiveWorkspaceId } from "../../../src/workspace/active";
import { colors, space, type as type$ } from "../../../src/design/tokens";
import { HeaderIconButton } from "../../../src/design/HeaderIconButton";
import { formatMoney, dateBucket } from "../../../src/format/money";
import { categoryMeta } from "../../../src/categories/meta";

const UNCATEGORIZED_ID = "__uncategorized__";

type ListResp = {
  transactions: TransactionDTO[];
  nextCursor: string | null;
};

function monthRangeIso(year: number, month: number): { from: string; to: string } {
  const from = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const to = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1, 0, 0, 0));
  return { from: from.toISOString(), to: to.toISOString() };
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-CA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function monthLabel(year: number, month: number): string {
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

export default function CategoryAnalysisDetail() {
  const params = useLocalSearchParams<{
    id: string;
    name?: string;
    year?: string;
    month?: string;
  }>();
  const id = params.id ?? "";
  const name = params.name ?? "Category";
  const year = Number(params.year) || new Date().getUTCFullYear();
  const month = Number(params.month) || new Date().getUTCMonth() + 1;
  const isUncategorized = id === UNCATEGORIZED_ID;

  const [txs, setTxs] = useState<TransactionDTO[] | null>(null);
  const [category, setCategory] = useState<CategoryDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const { from, to } = monthRangeIso(year, month);
      const qp = new URLSearchParams({
        from,
        to,
        limit: "200",
      });
      if (isUncategorized) {
        qp.set("uncategorizedOnly", "true");
      } else {
        qp.set("categoryId", id);
      }
      const [txResp, catResp] = await Promise.all([
        apiFetch<ListResp>(`/workspaces/${wsId}/transactions?${qp.toString()}`),
        isUncategorized
          ? Promise.resolve({ categories: [] as CategoryDTO[] })
          : apiFetch<{ categories: CategoryDTO[] }>(
              `/workspaces/${wsId}/categories`,
            ),
      ]);
      setTxs(txResp.transactions);
      if (!isUncategorized) {
        const cat = catResp.categories.find((c) => c.id === id) ?? null;
        setCategory(cat);
      }
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, [id, year, month, isUncategorized]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const meta = useMemo(() => {
    if (isUncategorized) {
      return {
        icon: "ellipsis-horizontal-outline" as const,
        fg: colors.muted,
        bg: colors.surfaceSoft,
      };
    }
    return categoryMeta(
      category ??
        ({
          id,
          name,
          icon: null,
          color: null,
        } as unknown as CategoryDTO),
    );
  }, [isUncategorized, category, id, name]);

  const total = useMemo(
    () => (txs ?? []).reduce((s, t) => s + Number(t.amount), 0),
    [txs],
  );

  const sections = useMemo(() => {
    if (!txs) return [];
    const buckets = new Map<string, TransactionDTO[]>();
    for (const t of txs) {
      const key = dateBucket(t.occurredAt);
      const arr = buckets.get(key) ?? [];
      arr.push(t);
      buckets.set(key, arr);
    }
    return Array.from(buckets, ([title, data]) => ({ title, data }));
  }, [txs]);

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
        <Text style={styles.navTitle} numberOfLines={1}>
          {name}
        </Text>
        <View style={{ width: 34 }} />
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
        ListHeaderComponent={
          <View style={styles.hero}>
            <View style={[styles.heroGlyph, { backgroundColor: meta.bg }]}>
              <Ionicons name={meta.icon} size={20} color={meta.fg} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.heroLabel}>{monthLabel(year, month)}</Text>
              <Text style={styles.heroAmount}>
                {formatMoney(total.toFixed(2)).display}
              </Text>
              <Text style={styles.heroMeta}>
                {txs?.length ?? 0} transaction
                {(txs?.length ?? 0) === 1 ? "" : "s"}
              </Text>
            </View>
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHead}>{section.title}</Text>
        )}
        renderItem={({ item }) => <TxRow tx={item} />}
        ListEmptyComponent={
          err ? (
            <View style={styles.fallback}>
              <Text style={styles.errTitle}>Couldn't load</Text>
              <Text style={styles.errBody}>{err}</Text>
              <Pressable style={styles.cta} onPress={load}>
                <Text style={styles.ctaText}>Try again</Text>
              </Pressable>
            </View>
          ) : txs === null ? (
            <View style={styles.fallback}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <View style={styles.fallback}>
              <View style={styles.emptyGlyph}>
                <Ionicons
                  name="receipt-outline"
                  size={28}
                  color={colors.muted}
                />
              </View>
              <Text style={styles.emptyTitle}>No transactions</Text>
              <Text style={styles.emptyBody}>
                Nothing in {name} this month.
              </Text>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

function TxRow({ tx }: { tx: TransactionDTO }) {
  const money = formatMoney(tx.amount, tx.currency);
  const merchant = tx.merchantNormalized || tx.merchantRaw || "—";
  return (
    <Pressable
      onPress={() => router.push(`/transactions/${tx.id}` as never)}
      style={({ pressed }) => [styles.txRow, pressed && { opacity: 0.6 }]}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.txMerchant} numberOfLines={1}>
          {merchant}
        </Text>
        {tx.pending && (
          <Text style={styles.txPending}>Pending</Text>
        )}
      </View>
      <View style={styles.txRight}>
        <Text
          style={[
            styles.txAmount,
            money.isIncome && { color: colors.up },
          ]}
        >
          {money.isIncome ? "+" : "−"}
          {money.display}
        </Text>
        <Text style={styles.txTime}>{formatTime(tx.occurredAt)}</Text>
      </View>
    </Pressable>
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

  list: { padding: space.lg, paddingBottom: space.xl },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.base,
    marginBottom: space.lg,
  },
  heroGlyph: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  heroLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 2,
  },
  heroAmount: {
    fontSize: 28,
    fontWeight: "600",
    color: colors.ink,
    letterSpacing: -0.6,
  },
  heroMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },

  sectionHead: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: space.base,
    marginBottom: 4,
  },
  txRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.sm,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  txMerchant: { ...type$.titleSm, color: colors.ink },
  txPending: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 2,
  },
  txRight: { alignItems: "flex-end" },
  txAmount: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  txTime: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 2,
    fontVariant: ["tabular-nums"],
  },

  fallback: { alignItems: "center", paddingVertical: space.xxl },
  emptyGlyph: {
    width: 56,
    height: 56,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.sm,
  },
  emptyTitle: { ...type$.titleSm, color: colors.ink, marginBottom: 4 },
  emptyBody: { ...type$.bodyMd, color: colors.body, textAlign: "center" },
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
});
