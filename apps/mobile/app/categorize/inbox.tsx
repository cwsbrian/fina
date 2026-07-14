import { useCallback, useState } from "react";
import { View, Text, ScrollView, StyleSheet, Pressable, Alert, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { MeDTO, TransactionDTO, CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { formatMoney } from "../../src/format/money";
import { CategoryPickerSheet } from "../../src/categories/CategoryPickerSheet";

type LoadResult = {
  txs: TransactionDTO[];
  categories: Record<string, CategoryDTO>;
  mode: "flexible" | "strict" | "auto";
  wsId: string;
};

export default function CategorizeInbox() {
  const [data, setData] = useState<LoadResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyTxId, setBusyTxId] = useState<string | null>(null);
  const [pickerTxId, setPickerTxId] = useState<string | null>(null);
  const [pickerSelectedId, setPickerSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const wsId = (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [me, list, cats] = await Promise.all([
        apiFetch<MeDTO>("/me"),
        apiFetch<{ transactions: TransactionDTO[] }>(`/workspaces/${wsId}/transactions?needsReview=true&limit=50`),
        apiFetch<{ categories: CategoryDTO[] }>(`/workspaces/${wsId}/categories`),
      ]);
      setData({
        txs: list.transactions,
        categories: Object.fromEntries(cats.categories.map((c) => [c.id, c])),
        mode: me.user.categorizationMode,
        wsId,
      });
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function confirmRow(tx: TransactionDTO) {
    if (!data) return;
    setBusyTxId(tx.id);
    setData({ ...data, txs: data.txs.filter((t) => t.id !== tx.id) });
    try {
      const result = await apiFetch<{ affectedTransactionIds?: string[] }>(
        `/workspaces/${data.wsId}/transactions/${tx.id}/confirm-category`,
        { method: "POST" },
      );
      const affected = new Set(result.affectedTransactionIds ?? [tx.id]);
      setData((current) => current
        ? { ...current, txs: current.txs.filter((t) => !affected.has(t.id)) }
        : current);
    } catch (e) {
      Alert.alert("Couldn't confirm", (e as { code?: string }).code ?? "Try again.");
      load();
    } finally {
      setBusyTxId(null);
    }
  }

  function editRow(tx: TransactionDTO) {
    setPickerTxId(tx.id);
    setPickerSelectedId(tx.allocations[0]?.categoryId ?? null);
  }

  async function skipOrDismissRow(tx: TransactionDTO) {
    if (!data) return;
    setBusyTxId(tx.id);
    setData({ ...data, txs: data.txs.filter((t) => t.id !== tx.id) });
    if (data.mode === "auto") {
      try {
        await apiFetch(`/workspaces/${data.wsId}/transactions/${tx.id}/dismiss-category`, { method: "POST" });
      } catch (e) {
        Alert.alert("Couldn't dismiss", (e as { code?: string }).code ?? "Try again.");
        load();
      }
    }
    setBusyTxId(null);
  }

  if (!data) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header />
        <View style={styles.fallback}>
          {err ? <Text style={styles.errText}>Couldn't load ({err})</Text> : <ActivityIndicator color={colors.primary} />}
        </View>
      </SafeAreaView>
    );
  }

  const empty = data.txs.length === 0;
  const cancelLabel = data.mode === "auto" ? "Dismiss" : "Skip";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header />
      <ScrollView contentContainerStyle={styles.scroll}>
        {empty ? (
          <View style={styles.emptyWrap}>
            <Ionicons name="checkmark-circle-outline" size={64} color={colors.primary} />
            <Text style={styles.emptyTitle}>All caught up</Text>
            <Text style={styles.emptySub}>Nothing to review.</Text>
          </View>
        ) : (
          data.txs.map((tx) => {
            const alloc = tx.allocations[0]!;
            const cat = alloc.categoryId ? data.categories[alloc.categoryId] : null;
            const merchant = tx.merchantNormalized ?? tx.merchantRaw;
            const money = formatMoney(tx.amount, tx.currency);
            const date = formatReviewDate(tx.occurredAt);
            const isOther = (cat?.name ?? "").trim().toLowerCase() === "other";
            return (
              <View key={tx.id} style={styles.row}>
                <View style={styles.rowGlyph}>
                  <Ionicons name="pricetag-outline" size={17} color={colors.muted} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.merchant} numberOfLines={1}>{merchant}</Text>
                  <View style={styles.rowMetaLine}>
                    <Text style={styles.catLabel} numberOfLines={1}>{cat?.name ?? "Uncategorized"}</Text>
                    {isOther && <View style={styles.otherDot} />}
                    <Text style={styles.dateLabel}>· {date}</Text>
                  </View>
                </View>
                <View style={styles.rowRight}>
                  <Text style={[styles.amount, money.isIncome && styles.amountIncome]}>
                    {money.isIncome ? "+" : "−"}{money.display}
                  </Text>
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityLabel={cancelLabel}
                      style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.55 }]}
                      onPress={() => skipOrDismissRow(tx)}
                      disabled={busyTxId === tx.id}
                      hitSlop={8}
                    >
                      <Ionicons name="close" size={18} color={colors.muted} />
                    </Pressable>
                    <Pressable
                      accessibilityLabel="Change category"
                      style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.55 }]}
                      onPress={() => editRow(tx)}
                      disabled={busyTxId === tx.id}
                      hitSlop={8}
                    >
                      <Ionicons name="pencil-outline" size={17} color={colors.muted} />
                    </Pressable>
                    <Pressable
                      accessibilityLabel="Confirm category"
                      style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.55 }]}
                      onPress={() => confirmRow(tx)}
                      disabled={busyTxId === tx.id}
                      hitSlop={8}
                    >
                      <Ionicons name="checkmark" size={18} color={colors.primary} />
                    </Pressable>
                  </View>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

      <CategoryPickerSheet
        visible={pickerTxId !== null}
        txId={pickerTxId ?? ""}
        selectedId={pickerSelectedId}
        categoryType={Number(data?.txs.find((tx) => tx.id === pickerTxId)?.amount) < 0
          ? "income"
          : "expense"}
        onClose={() => setPickerTxId(null)}
        onChange={(affectedTransactionIds) => {
          setPickerTxId(null);
          if (data && pickerTxId) {
            const affected = new Set(affectedTransactionIds ?? [pickerTxId]);
            setData({ ...data, txs: data.txs.filter((t) => !affected.has(t.id)) });
          }
        }}
      />
    </SafeAreaView>
  );
}

function Header() {
  return (
    <View style={styles.head}>
      <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
      <Text style={styles.title}>Review Activities</Text>
      <View style={{ width: 34 }} />
    </View>
  );
}

function formatReviewDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("en-CA", { month: "short", day: "numeric" });
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
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  scroll: { paddingHorizontal: space.lg, paddingBottom: space.xl, flexGrow: 1 },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  errText: { ...type$.bodyMd, color: colors.down },
  emptyWrap: { alignItems: "center", paddingVertical: space.xxl, gap: space.sm },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginTop: space.base },
  emptySub: { ...type$.bodySm, color: colors.muted },
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
  rowBody: { flex: 1, minWidth: 0 },
  merchant: { ...type$.titleSm, color: colors.ink },
  rowMetaLine: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0, marginTop: 2 },
  catLabel: { ...type$.bodySm, color: colors.muted, flexShrink: 1 },
  dateLabel: { ...type$.bodySm, color: colors.muted, flexShrink: 0 },
  otherDot: { width: 6, height: 6, borderRadius: 999, backgroundColor: colors.down, flexShrink: 0 },
  rowRight: { alignItems: "flex-end", gap: 5 },
  amount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] },
  amountIncome: { color: colors.up },
  actions: { flexDirection: "row", alignItems: "center", gap: 2 },
  actionBtn: {
    width: 26,
    height: 26,
    alignItems: "center",
    justifyContent: "center",
  },
});
