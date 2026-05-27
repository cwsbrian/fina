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
import { txDirection } from "../../src/categories/direction";

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
  const [pickerType, setPickerType] = useState<"expense" | "income">("expense");

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
      await apiFetch(`/workspaces/${data.wsId}/transactions/${tx.id}/confirm-category`, { method: "POST" });
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
    setPickerType(txDirection(tx.amount));
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
  const cancelHelper = data.mode === "auto" ? "Won't show again" : "Will show again next time";

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
            const isOther = (cat?.name ?? "").trim().toLowerCase() === "other";
            return (
              <View key={tx.id} style={styles.card}>
                <Pressable
                  accessibilityLabel={cancelLabel}
                  style={({ pressed }) => [styles.dismissCorner, pressed && { opacity: 0.5 }]}
                  onPress={() => skipOrDismissRow(tx)}
                  disabled={busyTxId === tx.id}
                  hitSlop={10}
                >
                  <Ionicons name="close" size={16} color={colors.muted} />
                </Pressable>
                <View style={styles.rowTop}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.merchant} numberOfLines={1}>{merchant}</Text>
                    <View style={styles.rowMid}>
                      <Text style={styles.catLabel}>{cat?.name ?? "Uncategorized"}</Text>
                      {isOther && (
                        <View style={styles.otherChip}>
                          <Text style={styles.otherChipText}>Other</Text>
                        </View>
                      )}
                    </View>
                  </View>
                  <Text style={[styles.amount, money.isIncome && { color: colors.up }]}>
                    {money.isIncome ? "+" : "−"}{money.display}
                  </Text>
                </View>
                <View style={styles.actions}>
                  <Pressable
                    accessibilityLabel="Confirm category"
                    style={({ pressed }) => [styles.confirmPill, pressed && { opacity: 0.7 }]}
                    onPress={() => confirmRow(tx)}
                    disabled={busyTxId === tx.id}
                    hitSlop={6}
                  >
                    <Text style={styles.confirmPillText}>Confirm</Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel="Change category"
                    style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.5 }]}
                    onPress={() => editRow(tx)}
                    disabled={busyTxId === tx.id}
                    hitSlop={8}
                  >
                    <Ionicons name="pencil-outline" size={18} color={colors.muted} />
                  </Pressable>
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
        categoryType={pickerType}
        onClose={() => setPickerTxId(null)}
        onChange={() => {
          setPickerTxId(null);
          if (data && pickerTxId) {
            setData({ ...data, txs: data.txs.filter((t) => t.id !== pickerTxId) });
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
      <Text style={styles.title}>Review queue</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.base, gap: space.sm, height: 56 },
  title: { ...type$.titleMd, color: colors.ink },
  scroll: { padding: space.lg, gap: space.sm },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  errText: { ...type$.bodyMd, color: colors.down },
  emptyWrap: { alignItems: "center", paddingVertical: space.xxl, gap: space.sm },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginTop: space.base },
  emptySub: { ...type$.bodySm, color: colors.muted },
  card: {
    backgroundColor: colors.surfaceSoft,
    borderRadius: 16,
    padding: space.base,
    marginBottom: space.sm,
    marginTop: 10,
    gap: 6,
    position: "relative",
    overflow: "visible",
  },
  dismissCorner: {
    position: "absolute",
    top: -10,
    right: -10,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 3,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 3,
    elevation: 2,
  },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  merchant: { ...type$.titleSm, color: colors.ink, flex: 1, marginRight: space.sm },
  amount: { ...type$.titleSm, color: colors.ink },
  rowMid: { flexDirection: "row", alignItems: "center", gap: 6 },
  catLabel: { ...type$.bodySm, color: colors.body },
  otherChip: { paddingHorizontal: 6, paddingVertical: 1, borderRadius: 6, backgroundColor: "rgba(207, 32, 47, 0.10)" },
  otherChipText: { fontSize: 10, color: colors.down, fontWeight: "600" },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: space.sm,
  },
  confirmPill: {
    paddingHorizontal: 14,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 4,
  },
  confirmPillText: {
    ...type$.bodySm,
    color: colors.onPrimary,
    fontWeight: "600",
    fontSize: 13,
  },
  iconBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
});
