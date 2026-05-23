import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type {
  TransactionDTO,
  CategoryDTO,
  BankAccountDTO,
} from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../src/api/client";
import { getActiveWorkspaceId } from "../../../src/workspace/active";
import { formatMoney } from "../../../src/format/money";
import { colors, space, type as type$ } from "../../../src/design/tokens";
import { HeaderIconButton } from "../../../src/design/HeaderIconButton";
import { categoryMeta } from "../../../src/categories/meta";
import { CategoryPickerSheet } from "../../../src/categories/CategoryPickerSheet";
import { NoteEditorSheet } from "../../../src/transactions/NoteEditorSheet";

type SingleTxResp = { transaction: TransactionDTO };
type AccountsResp = { accounts: BankAccountDTO[] };
type CategoriesResp = { categories: CategoryDTO[] };

export default function TransactionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [tx, setTx] = useState<TransactionDTO | null>(null);
  const [account, setAccount] = useState<BankAccountDTO | null>(null);
  const [categories, setCategories] = useState<Record<string, CategoryDTO>>({});
  const [err, setErr] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const [t, a, c] = await Promise.all([
        apiFetch<SingleTxResp>(`/workspaces/${wsId}/transactions/${id}`),
        apiFetch<AccountsResp>(`/workspaces/${wsId}/accounts`),
        apiFetch<CategoriesResp>(`/workspaces/${wsId}/categories`),
      ]);
      setTx(t.transaction);
      setAccount(a.accounts.find((x) => x.id === t.transaction.accountId) ?? null);
      setCategories(Object.fromEntries(c.categories.map((x) => [x.id, x])));
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, [id]);

  // Reload on focus so the category change/note edits done elsewhere
  // (e.g. picker push → back) reflect immediately.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onDelete = () => {
    if (!tx) return;
    Alert.alert("Delete transaction?", "This hides it from your activity.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            const wsId = await getActiveWorkspaceId();
            if (!wsId) throw new Error("no_workspace");
            await apiFetch(`/workspaces/${wsId}/transactions/${tx.id}`, {
              method: "DELETE",
            });
            router.back();
          } catch (e) {
            Alert.alert(
              "Couldn't delete",
              (e as { code?: string }).code ?? "Try again.",
            );
          }
        },
      },
    ]);
  };

  if (err) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header onBack={() => router.back()} />
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!tx) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header onBack={() => router.back()} />
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const money = formatMoney(tx.amount, tx.currency);
  const isSplit = tx.allocations.length > 1;
  const merchant = tx.merchantNormalized || tx.merchantRaw || "—";
  const firstAlloc = tx.allocations[0];
  const firstCat = firstAlloc?.categoryId ? categories[firstAlloc.categoryId] : null;
  const heroMeta = categoryMeta(firstCat);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header onBack={() => router.back()} />
      <ScrollView contentContainerStyle={styles.scroll}>
        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <View style={[styles.heroGlyph, { backgroundColor: heroMeta.bg }]}>
              <Ionicons name={heroMeta.icon} size={22} color={heroMeta.fg} />
            </View>
            <Text style={styles.heroTitle} numberOfLines={2}>
              {merchant}
            </Text>
          </View>
          <Text
            style={[
              styles.heroAmount,
              money.isIncome && { color: colors.up },
            ]}
          >
            {money.isIncome ? "+" : "−"}
            {money.display}
          </Text>
          <View style={styles.heroMetaRow}>
            <Text style={styles.heroMeta}>{formatDateTime(tx.occurredAt)}</Text>
            {isSplit && (
              <>
                <View style={styles.heroDot} />
                <View style={styles.splitPill}>
                  <Text style={styles.splitPillText}>
                    SPLIT · {tx.allocations.length}
                  </Text>
                </View>
              </>
            )}
          </View>
        </View>

        {/* Details */}
        <Text style={styles.groupLabel}>Details</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Account</Text>
            <Text style={styles.rowValue}>
              {accountLabel(account)}
            </Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Status</Text>
            <View style={styles.statusValue}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: tx.pending ? colors.muted : colors.up },
                ]}
              />
              <Text style={styles.rowValue}>
                {tx.pending ? "Pending" : "Posted"}
              </Text>
            </View>
          </View>
          {isSplit && tx.merchantRaw !== merchant && (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Merchant</Text>
              <Text style={styles.rowValue} numberOfLines={1}>
                {tx.merchantRaw}
              </Text>
            </View>
          )}
        </View>

        {/* Category */}
        {!isSplit ? (
          <>
            <Text style={styles.groupLabel}>Category</Text>
            <View style={styles.group}>
              <Pressable
                style={({ pressed }) => [
                  styles.catRow,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() => setPickerOpen(true)}
              >
                <View style={[styles.catGlyph, { backgroundColor: heroMeta.bg }]}>
                  <Ionicons name={heroMeta.icon} size={16} color={heroMeta.fg} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.catName}>
                    {firstCat?.name ?? "Uncategorized"}
                  </Text>
                  <Text style={styles.catMeta}>
                    All {money.display} in one category
                  </Text>
                </View>
                <Text style={styles.changeLink}>Change</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.splitCta,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() =>
                  Alert.alert(
                    "Coming soon",
                    "Splitting a transaction across categories is on the way.",
                  )
                }
              >
                <View style={styles.splitCtaGlyph}>
                  <Ionicons name="pricetags-outline" size={14} color={colors.muted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.splitCtaTitle}>
                    Split across multiple categories
                  </Text>
                  <Text style={styles.splitCtaSub}>
                    e.g. some groceries, some household items
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedSoft}
                />
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <View style={styles.groupLabelRow}>
              <Text style={styles.groupLabel}>Categories</Text>
              <Text style={styles.groupLabelMeta}>
                Split across {tx.allocations.length}
              </Text>
            </View>
            <View style={styles.group}>
              {tx.allocations.map((a) => {
                const c = a.categoryId ? categories[a.categoryId] : null;
                const m = formatMoney(a.amount, tx.currency);
                const am = categoryMeta(c);
                return (
                  <View key={a.id} style={styles.allocRow}>
                    <View style={[styles.catGlyph, { backgroundColor: am.bg }]}>
                      <Ionicons name={am.icon} size={14} color={am.fg} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.catName}>
                        {c?.name ?? "Uncategorized"}
                      </Text>
                    </View>
                    <Text style={styles.allocAmount}>
                      {m.isIncome ? "+" : "−"}
                      {m.display}
                    </Text>
                  </View>
                );
              })}
              <Pressable
                style={({ pressed }) => [
                  styles.splitCta,
                  pressed && { opacity: 0.6 },
                ]}
                onPress={() =>
                  Alert.alert(
                    "Coming soon",
                    "Editing splits is on the way.",
                  )
                }
              >
                <View style={[styles.splitCtaGlyph, { backgroundColor: colors.surfaceSoft }]}>
                  <Ionicons name="create-outline" size={14} color={colors.muted} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.splitCtaTitle}>Edit split</Text>
                  <Text style={styles.splitCtaSub}>
                    Adjust categories or amounts
                  </Text>
                </View>
                <Ionicons
                  name="chevron-forward"
                  size={16}
                  color={colors.mutedSoft}
                />
              </Pressable>
            </View>
          </>
        )}

        {/* Note */}
        <Text style={styles.groupLabel}>Note</Text>
        <View style={styles.group}>
          <Pressable
            style={({ pressed }) => [
              styles.noteRow,
              pressed && { opacity: 0.6 },
            ]}
            onPress={() => setNoteOpen(true)}
          >
            <Text
              style={[
                styles.noteText,
                !tx.note && { color: colors.mutedSoft },
              ]}
            >
              {tx.note ?? "Add a note"}
            </Text>
          </Pressable>
        </View>

        {/* Delete */}
        <View style={{ paddingHorizontal: space.base, paddingTop: space.lg, paddingBottom: space.xl }}>
          <Pressable
            style={({ pressed }) => [
              styles.deleteBtn,
              pressed && { opacity: 0.6 },
            ]}
            onPress={onDelete}
          >
            <Text style={styles.deleteText}>Delete transaction</Text>
          </Pressable>
        </View>
      </ScrollView>

      <CategoryPickerSheet
        visible={pickerOpen}
        txId={tx.id}
        selectedId={firstAlloc?.categoryId ?? null}
        onClose={() => setPickerOpen(false)}
        onChange={() => {
          setPickerOpen(false);
          load();
        }}
      />

      <NoteEditorSheet
        visible={noteOpen}
        txId={tx.id}
        initialNote={tx.note}
        onClose={() => setNoteOpen(false)}
        onSaved={(next) => {
          setTx({ ...tx, note: next });
          setNoteOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.nav}>
      <HeaderIconButton icon="chevron-back" accessibilityLabel="Back" onPress={onBack} variant="plain" />
      <Text style={styles.navTitle}>Transaction</Text>
      <View style={{ width: 34 }} />
    </View>
  );
}

function accountLabel(a: BankAccountDTO | null): string {
  if (!a) return "—";
  const name = a.name || a.officialName || "Account";
  return a.mask ? `${name} ··${a.mask}` : name;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${date} · ${time}`;
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
  navTitle: { ...type$.titleSm, color: colors.ink },
  scroll: { paddingBottom: space.xl },
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

  // Hero
  hero: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    marginBottom: space.base,
  },
  heroGlyph: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: { ...type$.titleMd, color: colors.ink, flex: 1, flexShrink: 1 },
  heroAmount: {
    fontSize: 38,
    lineHeight: 38,
    fontWeight: "500",
    letterSpacing: -1.4,
    color: colors.ink,
    marginTop: 4,
  },
  heroMetaRow: { flexDirection: "row", alignItems: "center", marginTop: 6, gap: 6 },
  heroMeta: { ...type$.bodySm, color: colors.muted },
  heroDot: { width: 3, height: 3, borderRadius: 999, backgroundColor: colors.mutedSoft },
  splitPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.surfaceStrong,
  },
  splitPillText: {
    fontSize: 10.5,
    fontWeight: "700",
    letterSpacing: 0.4,
    color: colors.muted,
  },

  // Group label
  groupLabel: {
    ...type$.bodySm,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
    fontWeight: "600",
  },
  groupLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  groupLabelMeta: {
    ...type$.bodySm,
    color: colors.muted,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  group: {
    marginHorizontal: space.base,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 16,
    overflow: "hidden",
  },

  // Row
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  rowLabel: { ...type$.bodyMd, color: colors.ink },
  rowValue: { ...type$.bodyMd, color: colors.muted, flexShrink: 1, marginLeft: space.sm },
  statusValue: { flexDirection: "row", alignItems: "center", gap: 6 },
  statusDot: { width: 6, height: 6, borderRadius: 999 },

  // Category
  catRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: space.base,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  catGlyph: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.canvas,
    alignItems: "center",
    justifyContent: "center",
  },
  catName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  catMeta: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  changeLink: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },

  // Split CTA
  splitCta: {
    flexDirection: "row",
    alignItems: "center",
    padding: space.base,
    gap: space.sm,
  },
  splitCtaGlyph: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: colors.canvas,
    alignItems: "center",
    justifyContent: "center",
  },
  splitCtaTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  splitCtaSub: { ...type$.bodySm, color: colors.muted, marginTop: 1 },

  // Allocation row (split mode)
  allocRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: space.base,
    gap: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  allocAmount: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", fontVariant: ["tabular-nums"] },

  // Note
  noteRow: { padding: space.base + 2 },
  noteText: { ...type$.bodyMd, color: colors.body },

  // Delete
  deleteBtn: {
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteText: { ...type$.button, color: colors.down },
});
