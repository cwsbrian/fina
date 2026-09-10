import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO, TransactionDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { formatMoney } from "../../src/format/money";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { getSeenExcludedIds, rememberSeenExcludedIds } from "../../src/transactions/excludedSeen";

type TxListResp = {
  transactions: TransactionDTO[];
  nextCursor: string | null;
};

export default function ExcludedTransactions() {
  const [txs, setTxs] = useState<TransactionDTO[] | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const { from, to } = currentMonthRange();
      const [data, categoryData] = await Promise.all([
        apiFetch<TxListResp>(
          `/workspaces/${wsId}/transactions?budgetImpact=excluded&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`,
        ),
        apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${wsId}/categories`),
      ]);
      const seen = await getSeenExcludedIds();
      const fresh = data.transactions.filter((tx) => !seen.has(tx.id)).map((tx) => tx.id);
      setTxs(data.transactions);
      setCategories(Object.fromEntries(categoryData.categories.map((category) => [category.id, category])));
      setNewIds(new Set(fresh));
      if (data.transactions.length > 0) {
        await rememberSeenExcludedIds(data.transactions.map((tx) => tx.id));
      }
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  async function addToBudget(tx: TransactionDTO) {
    if (savingId) return;
    setSavingId(tx.id);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${tx.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          budgetImpact: moneyDirectionForExcluded(tx, categories),
        }),
      });
      setTxs((cur) => (cur ?? []).filter((x) => x.id !== tx.id));
    } catch (e) {
      Alert.alert("Couldn't update", (e as { code?: string }).code ?? "Try again.");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
        <Text style={styles.title}>Excluded transactions</Text>
        <View style={{ width: 34 }} />
      </View>

      {txs === null && !err ? (
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : err ? (
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={txs ?? []}
          keyExtractor={(tx) => tx.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Ionicons name="eye-off-outline" size={32} color={colors.muted} />
              </View>
              <Text style={styles.emptyTitle}>Nothing excluded</Text>
            </View>
          }
          renderItem={({ item }) => (
            <ExcludedRow
              tx={item}
              isNew={newIds.has(item.id)}
              saving={savingId === item.id}
              onAdd={() => addToBudget(item)}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function ExcludedRow({
  tx,
  isNew,
  saving,
  onAdd,
}: {
  tx: TransactionDTO;
  isNew: boolean;
  saving: boolean;
  onAdd: () => void;
}) {
  const money = formatMoney(tx.amount, tx.currency);
  const merchant = tx.merchantNormalized || tx.merchantRaw || "-";
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
      onPress={() => router.push(`/transactions/${tx.id}` as never)}
    >
      <View style={styles.rowGlyph}>
        <Ionicons name="eye-off-outline" size={17} color={colors.muted} />
      </View>
      <View style={styles.rowMid}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>{merchant}</Text>
          {isNew && <View style={styles.newDot} />}
        </View>
        <Text style={styles.rowMeta}>
          {formatDate(tx.occurredAt)}
          {tx.merchantExclusionActive ? " · Always excluded" : ""}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.rowAmount, money.isIncome && styles.rowAmountIncome]}>
          {money.isIncome ? "+" : "−"}{money.display}
        </Text>
        <Pressable
          style={({ pressed }) => [styles.addBtn, pressed && { opacity: 0.65 }]}
          onPress={(e) => {
            e.stopPropagation();
            onAdd();
          }}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.addBtnText}>Add</Text>
          )}
        </Pressable>
      </View>
    </Pressable>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function moneyDirectionForExcluded(
  tx: TransactionDTO,
  categories: Record<string, CategoryDTO>,
): "expense" | "income" | "refund" {
  if (Number(tx.amount) >= 0) return "expense";
  const categoryId = tx.allocations[0]?.categoryId;
  const categoryName = categoryId ? categories[categoryId]?.name.trim().toLowerCase() : null;
  return categoryName === "refund" ? "refund" : "income";
}

function currentMonthRange(): { from: string; to: string } {
  const now = new Date();
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    to: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString(),
  };
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  title: { ...type$.titleSm, color: colors.ink },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  list: { padding: space.lg, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 120 },
  emptyIcon: {
    width: 70,
    height: 70,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.base,
  },
  emptyTitle: { ...type$.titleMd, color: colors.ink },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  rowGlyph: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  rowMid: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  rowTitle: { ...type$.titleSm, color: colors.ink, flexShrink: 1 },
  newDot: { width: 7, height: 7, borderRadius: 999, backgroundColor: colors.primary },
  rowMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  rowRight: { alignItems: "flex-end", gap: 6 },
  rowAmount: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  rowAmountIncome: { color: colors.up },
  addBtn: {
    minWidth: 48,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  addBtnText: { ...type$.bodySm, color: colors.primary, fontWeight: "700" },
});
