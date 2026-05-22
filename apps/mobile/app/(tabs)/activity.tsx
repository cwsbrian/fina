import { useCallback, useEffect, useState } from "react";
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
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO, TransactionDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { formatMoney, dateBucket } from "../../src/format/money";
import { colors, space, type as type$ } from "../../src/design/tokens";

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

export default function Activity() {
  const [txs, setTxs] = useState<TransactionDTO[] | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [wsId, setWsId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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
        <View style={styles.head}>
          <Text style={styles.title}>Activity</Text>
        </View>
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
        <View style={styles.head}>
          <Text style={styles.title}>Activity</Text>
        </View>
        <View style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  if (txs.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <View style={styles.head}>
          <Text style={styles.title}>Activity</Text>
        </View>
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.head}>
        <Text style={styles.title}>Activity</Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHead}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <TxRow tx={item} categories={categories} wsId={wsId} />
        )}
      />
    </SafeAreaView>
  );
}

function TxRow({
  tx,
  categories,
  wsId,
}: {
  tx: TransactionDTO;
  categories: Record<string, CategoryDTO>;
  wsId: string | null;
}) {
  const money = formatMoney(tx.amount, tx.currency);
  // Single allocation = simple display. Multiple = "split" tag.
  const isSplit = tx.allocations.length > 1;
  const firstAllocCat = tx.allocations[0]?.categoryId
    ? categories[tx.allocations[0].categoryId]
    : null;
  const merchant = tx.merchantNormalized || tx.merchantRaw || "—";
  const categoryLabel = isSplit
    ? "Split"
    : firstAllocCat?.name ?? "Uncategorized";
  return (
    <View style={styles.row}>
      <View style={styles.rowGlyph}>
        <Ionicons
          name={money.isIncome ? "trending-up" : "card-outline"}
          size={18}
          color={money.isIncome ? colors.up : colors.muted}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {merchant}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {categoryLabel}
          {tx.pending ? " · Pending" : ""}
        </Text>
      </View>
      <Text
        style={[
          styles.rowAmount,
          money.isIncome && { color: colors.up },
        ]}
      >
        {money.isIncome ? "+" : ""}
        {money.display}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { padding: space.lg, paddingBottom: 0 },
  title: { ...type$.titleLg, color: colors.ink },
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
  listContent: { padding: space.lg, paddingTop: space.sm, gap: 6 },
  sectionHead: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    marginTop: space.base,
    marginBottom: 6,
  },
  row: {
    flexDirection: "row", alignItems: "center", gap: space.sm,
    paddingVertical: 10,
  },
  rowGlyph: {
    width: 40, height: 40, borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center", justifyContent: "center",
  },
  rowTitle: { ...type$.titleSm, color: colors.ink },
  rowMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  rowAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
});
