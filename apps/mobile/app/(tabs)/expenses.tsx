import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import type { BusinessExpenseRow } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspaceSummary } from "../../src/api/client";
import { formatMoney } from "../../src/format/money";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { useCollapsingHeader } from "../../src/design/useCollapsingHeader";
import {
  pickAndUploadReceipt,
  type ReceiptRole,
  type ReceiptSource,
} from "../../src/receipts/upload";

type Filter = "business" | "review" | "missing";
const HEADER_HEIGHT = 84;

export default function Expenses() {
  const insets = useSafeAreaInsets();
  const header = useCollapsingHeader(HEADER_HEIGHT);
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [filter, setFilter] = useState<Filter>("business");
  const [rows, setRows] = useState<BusinessExpenseRow[] | null>(null);
  const [currency, setCurrency] = useState("CAD");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const load = useCallback(async () => {
    try {
      const workspace = await bootstrapActiveWorkspaceSummary();
      if (!workspace || workspace.kind !== "business") return;
      setCurrency(workspace.currency);
      setCanEdit(workspace.role !== "viewer");
      const result = await apiFetch<{ expenses: BusinessExpenseRow[] }>(
        `/workspaces/${workspace.id}/business/expenses?yearMonth=${month}&view=${filter}`,
      );
      setRows(result.expenses);
      setError(null);
    } catch (e) {
      setError((e as { code?: string }).code ?? "load_error");
    }
  }, [filter, month]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const upload = async (role: ReceiptRole, source: ReceiptSource) => {
    setUploading(true);
    try {
      const receiptId = await pickAndUploadReceipt({ role, source });
      if (receiptId) router.push(`/receipts/${receiptId}` as never);
    } catch (e) {
      Alert.alert(
        "Couldn't upload receipt",
        (e as { code?: string; message?: string }).code ?? (e as Error).message,
      );
    } finally {
      setUploading(false);
    }
  };
  const chooseSource = (role: ReceiptRole) =>
    Alert.alert("Add receipt", "Choose a source.", [
      { text: "Camera", onPress: () => upload(role, "camera") },
      { text: "Photo Library", onPress: () => upload(role, "library") },
      { text: "Files", onPress: () => upload(role, "files") },
      { text: "Cancel", style: "cancel" },
    ]);
  const scan = () =>
    Alert.alert(
      "What does this document show?",
      "A single document can satisfy both evidence roles.",
      [
        { text: "Itemized + payment", onPress: () => chooseSource("combined") },
        { text: "Itemized receipt", onPress: () => chooseSource("itemized") },
        { text: "Payment proof", onPress: () => chooseSource("payment_proof") },
        { text: "Cancel", style: "cancel" },
      ],
    );
  const shiftMonth = (delta: number) => {
    const [year, m] = month.split("-").map(Number);
    setRows(null);
    setMonth(new Date(Date.UTC(year!, m! - 1 + delta, 1)).toISOString().slice(0, 7));
  };

  return (
    <View style={styles.safe}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + HEADER_HEIGHT }]}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
      >
        <View style={styles.month}>
          <Pressable onPress={() => shiftMonth(-1)} hitSlop={8}>
            <Ionicons name="chevron-back" size={20} color={colors.ink} />
          </Pressable>
          <Text style={styles.monthText}>
            {new Date(`${month}-02T00:00:00Z`).toLocaleDateString(undefined, {
              month: "long",
              year: "numeric",
            })}
          </Text>
          <Pressable onPress={() => shiftMonth(1)} hitSlop={8}>
            <Ionicons name="chevron-forward" size={20} color={colors.ink} />
          </Pressable>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filters}
        >
          {(
            [
              ["business", "Business expenses"],
              ["review", "Expense review"],
              ["missing", "Missing evidence"],
            ] as const
          ).map(([id, label]) => (
            <Pressable
              key={id}
              onPress={() => {
                setRows(null);
                setFilter(id);
              }}
              style={[styles.filter, filter === id && styles.filterActive]}
            >
              <Text style={[styles.filterText, filter === id && styles.filterTextActive]}>
                {label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {error ? (
          <View style={styles.center}>
            <Text style={styles.error}>{error}</Text>
            <Pressable onPress={load}>
              <Text style={styles.retry}>Try again</Text>
            </Pressable>
          </View>
        ) : rows === null ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <View style={styles.list}>
            {rows.length ? (
              rows.map((row, index) => (
                <Pressable
                  key={row.transactionId}
                  style={[styles.row, index < rows.length - 1 && styles.rowBorder]}
                  onPress={() => router.push(`/transactions/${row.transactionId}` as never)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{row.merchant}</Text>
                    <View style={styles.metaLine}>
                      {row.partial && <Text style={styles.partial}>Partial</Text>}
                      <Text style={styles.rowMeta}>
                        {row.expenseReview
                          ? "Expense review"
                          : row.evidenceStatus.replaceAll("_", " ")}
                      </Text>
                    </View>
                    <Text style={styles.rowTotal}>
                      Total {formatMoney(row.totalAmount, currency).display}
                    </Text>
                  </View>
                  <Text style={styles.amount}>
                    {row.businessAmount === null
                      ? "—"
                      : formatMoney(row.businessAmount, currency).display}
                  </Text>
                </Pressable>
              ))
            ) : (
              <View style={styles.empty}>
                <View style={styles.iconWrap}>
                  <Ionicons name="receipt-outline" size={34} color={colors.muted} />
                </View>
                <Text style={styles.emptyTitle}>Nothing here</Text>
                <Text style={styles.emptyBody}>
                  Transactions move here as you classify business use and add evidence.
                </Text>
              </View>
            )}
          </View>
        )}
      </ScrollView>
      <Animated.View
        style={[
          styles.headerOverlay,
          { top: insets.top, height: HEADER_HEIGHT },
          header.headerStyle,
        ]}
      >
        <View style={styles.head}>
          <View>
            <Text style={styles.title}>Expenses</Text>
            <Text style={styles.subtitle}>Business expenses and receipts</Text>
          </View>
          {canEdit && (
            <View style={styles.headAction}>
              {uploading ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <HeaderIconButton
                  icon="scan-outline"
                  onPress={scan}
                  accessibilityLabel="Scan receipt"
                />
              )}
            </View>
          )}
        </View>
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />
    </View>
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
  head: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: 12,
    height: HEADER_HEIGHT,
  },
  headAction: { alignSelf: "center" },
  title: { ...type$.titleLg, color: colors.ink },
  subtitle: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  content: { paddingHorizontal: space.lg, paddingBottom: 80, flexGrow: 1 },
  month: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: space.sm,
  },
  monthText: { ...type$.titleSm, color: colors.ink },
  filters: { gap: 8, paddingVertical: space.sm, paddingRight: space.lg },
  filter: {
    minHeight: 32,
    justifyContent: "center",
    paddingHorizontal: 13,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  filterActive: { backgroundColor: colors.ink, borderColor: colors.ink },
  filterText: { ...type$.captionStrong, color: colors.muted },
  filterTextActive: { color: colors.canvas },
  center: { minHeight: 300, alignItems: "center", justifyContent: "center", gap: 10 },
  error: { ...type$.bodyMd, color: colors.down },
  retry: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  list: {
    marginTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
  },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairlineSoft,
  },
  rowTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  metaLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  partial: { ...type$.captionStrong, color: colors.primary, textTransform: "uppercase" },
  rowMeta: { ...type$.bodySm, color: colors.muted, textTransform: "capitalize" },
  rowTotal: { ...type$.bodySm, color: colors.mutedSoft, marginTop: 2 },
  amount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] },
  empty: { alignItems: "center", paddingVertical: 64 },
  iconWrap: {
    width: 72,
    height: 72,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyTitle: { ...type$.titleMd, color: colors.ink, marginTop: space.base },
  emptyBody: {
    ...type$.bodyMd,
    color: colors.body,
    textAlign: "center",
    maxWidth: 320,
    marginTop: 6,
  },
});
