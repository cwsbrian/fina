import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
} from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { Swipeable } from "react-native-gesture-handler";
import { router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

// Same pastel pair as the category picker's swipe action.
const SWIPE_DELETE_FG = "#b54550";
import type { BankAccountDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../api/client";
import { getActiveWorkspaceId } from "../workspace/active";
import { colors, space, type as type$ } from "../design/tokens";

type Props = {
  visible: boolean;
  txId: string;
  selectedId?: string | null;
  onClose: () => void;
  onChange: () => void;
};

type Item =
  | { kind: "header" }
  | { kind: "acct"; acct: BankAccountDTO }
  | { kind: "create" };

function label(a: BankAccountDTO): string {
  const name = a.name || a.officialName || "Account";
  return a.mask ? `${name} ··${a.mask}` : name;
}

export function AccountPickerSheet({
  visible,
  txId,
  selectedId,
  onClose,
  onChange,
}: Props) {
  const ref = useRef<BottomSheet>(null);
  const swipeRefs = useRef<Map<string, Swipeable | null>>(new Map());
  const [accts, setAccts] = useState<BankAccountDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const snapPoints = useMemo(() => ["90%"], []);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const data = await apiFetch<{ accounts: BankAccountDTO[] }>(
        `/workspaces/${wsId}/accounts`,
      );
      // Manual accounts only — the API rejects plaid-linked rows on
      // PATCH accountId.
      setAccts(
        data.accounts
          .filter((a) => a.plaidAccountId === null && a.status === "active")
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useEffect(() => {
    if (visible) load();
    else setSaving(null);
  }, [visible, load]);

  useFocusEffect(
    useCallback(() => {
      if (visible) load();
    }, [visible, load]),
  );

  const pick = async (a: BankAccountDTO) => {
    if (saving) return;
    setSaving(a.id);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${txId}`, {
        method: "PATCH",
        body: JSON.stringify({ accountId: a.id }),
      });
      ref.current?.close();
      onChange();
    } catch (e) {
      setSaving(null);
      Alert.alert(
        "Couldn't update account",
        (e as { code?: string }).code ?? "Try again.",
      );
    }
  };

  const startCreate = useCallback(() => {
    // Don't close the sheet — the new-account screen pops back into a
    // still-open picker so Cancel + Save both land the user where they
    // expected. useFocusEffect refreshes the list on return.
    router.push(`/transactions/${txId}/new-account` as never);
  }, [txId]);

  const confirmArchive = useCallback((a: BankAccountDTO) => {
    Alert.alert(
      `Delete "${a.name}"?`,
      "Existing transactions assigned to this account keep their link.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const wsId = await getActiveWorkspaceId();
              if (!wsId) throw new Error("no_workspace");
              await apiFetch(`/workspaces/${wsId}/accounts/${a.id}`, {
                method: "PATCH",
                body: JSON.stringify({ archived: true }),
              });
              setAccts((prev) =>
                prev ? prev.filter((x) => x.id !== a.id) : prev,
              );
            } catch (e) {
              Alert.alert(
                "Couldn't delete account",
                (e as { code?: string }).code ?? "Try again.",
              );
            }
          },
        },
      ],
    );
  }, []);

  const items: Item[] = useMemo(() => {
    if (!accts) return [];
    const rows: Item[] = [{ kind: "header" }];
    for (const a of accts) rows.push({ kind: "acct", acct: a });
    rows.push({ kind: "create" });
    return rows;
  }, [accts]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.35}
        pressBehavior="close"
      />
    ),
    [],
  );

  return (
    <BottomSheet
      ref={ref}
      snapPoints={snapPoints}
      enableDynamicSizing={false}
      index={visible ? 0 : -1}
      backdropComponent={renderBackdrop}
      onClose={() => {
        swipeRefs.current.forEach((s) => s?.close());
        onClose();
      }}
      handleIndicatorStyle={styles.grabber}
      backgroundStyle={styles.background}
      enablePanDownToClose
    >
      {!accts && !err && (
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      )}
      {err && (
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load accounts</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      )}
      {accts && (
        <BottomSheetFlatList
          data={items}
          keyExtractor={(item) =>
            item.kind === "acct" ? item.acct.id : item.kind
          }
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.list}
          stickyHeaderIndices={[0]}
          ItemSeparatorComponent={({ leadingItem }) =>
            leadingItem?.kind === "header" ? null : <View style={styles.sep} />
          }
          renderItem={({ item }) => {
            if (item.kind === "header") {
              return (
                <View style={styles.stickyHeader}>
                  <View style={styles.head}>
                    <Text style={styles.title}>Account</Text>
                    <Pressable
                      style={({ pressed }) => [
                        styles.closeBtn,
                        pressed && { opacity: 0.6 },
                      ]}
                      onPress={() => ref.current?.close()}
                      accessibilityLabel="Close"
                      hitSlop={8}
                    >
                      <Ionicons name="close" size={22} color={colors.muted} />
                    </Pressable>
                  </View>
                </View>
              );
            }
            if (item.kind === "create") {
              return (
                <Pressable
                  style={({ pressed }) => [
                    styles.row,
                    styles.createRow,
                    pressed && { opacity: 0.6 },
                  ]}
                  onPress={startCreate}
                >
                  <View
                    style={[
                      styles.glyph,
                      { backgroundColor: colors.surfaceSoft },
                    ]}
                  >
                    <Ionicons name="add" size={18} color={colors.ink} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.name}>Create new account</Text>
                    <Text style={styles.sub}>Cash, debit, credit, etc.</Text>
                  </View>
                </Pressable>
              );
            }
            const a = item.acct;
            const isSel = a.id === selectedId;
            const isSaving = saving === a.id;
            return (
              <Swipeable
                ref={(r) => {
                  if (r) swipeRefs.current.set(a.id, r);
                  else swipeRefs.current.delete(a.id);
                }}
                friction={2}
                rightThreshold={40}
                overshootRight={false}
                renderRightActions={() => (
                  <View style={styles.swipeActions}>
                    <Pressable
                      style={({ pressed }) => [
                        styles.swipeBtn,
                        styles.deleteBtn,
                        pressed && { opacity: 0.6 },
                      ]}
                      onPress={() => confirmArchive(a)}
                    >
                      <Ionicons
                        name="trash-outline"
                        size={20}
                        color={SWIPE_DELETE_FG}
                      />
                      <Text style={[styles.swipeBtnText, { color: SWIPE_DELETE_FG }]}>
                        Delete
                      </Text>
                    </Pressable>
                  </View>
                )}
              >
                <Pressable
                  style={({ pressed }) => [
                    styles.row,
                    { backgroundColor: colors.canvas },
                    pressed && { backgroundColor: colors.surfaceSoft },
                  ]}
                  disabled={!!saving}
                  onPress={() => pick(a)}
                >
                  <Text style={styles.name}>{label(a)}</Text>
                  {isSaving ? (
                    <ActivityIndicator size="small" color={colors.primary} />
                  ) : isSel ? (
                    <View style={styles.selectedMark}>
                      <Ionicons
                        name="checkmark"
                        size={14}
                        color={colors.onPrimary}
                      />
                    </View>
                  ) : null}
                </Pressable>
              </Swipeable>
            );
          }}
        />
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  background: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  grabber: { backgroundColor: colors.mutedSoft, width: 36, height: 4 },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base, textAlign: "center" },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  list: { paddingBottom: space.xl },
  stickyHeader: { backgroundColor: colors.canvas, paddingBottom: 4 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
    paddingTop: space.xs,
    paddingBottom: space.sm,
  },
  title: { ...type$.titleMd, color: colors.ink, fontWeight: "600" },
  closeBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 12,
  },
  createRow: { marginTop: space.sm },
  glyph: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", flex: 1 },
  sub: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  sep: {
    height: 1,
    backgroundColor: colors.hairlineSoft,
    marginLeft: 24,
  },
  swipeActions: { flexDirection: "row" },
  swipeBtn: {
    width: 78,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  swipeBtnText: { ...type$.bodySm, fontWeight: "600" },
  deleteBtn: { backgroundColor: "#fde6e7" },
  selectedMark: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
