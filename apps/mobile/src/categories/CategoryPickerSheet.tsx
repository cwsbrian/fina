import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  ActivityIndicator,
  Alert,
  TextInput,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../api/client";
import { getActiveWorkspaceId } from "../workspace/active";
import { colors, space, type as type$ } from "../design/tokens";
import { categoryMeta } from "./meta";

type Props = {
  visible: boolean;
  txId: string;
  /** Currently selected category id (highlighted in the list). null
   *  means the tx is uncategorised. */
  selectedId?: string | null;
  /** Closes the sheet without applying anything (× button, backdrop tap). */
  onClose: () => void;
  /** Fires after a successful PATCH so the parent can refresh and close. */
  onChange: () => void;
};

type CategoriesResp = { categories: CategoryDTO[] };

type Item =
  | { kind: "none" }
  | { kind: "cat"; cat: CategoryDTO }
  | { kind: "create" };

/** Bottom-sheet category picker. Renders as a transparent Modal so the
 *  detail screen stays visible (dimmed) behind it — matches the design's
 *  "Choose category" sheet. */
export function CategoryPickerSheet({
  visible,
  txId,
  selectedId,
  onClose,
  onChange,
}: Props) {
  const insets = useSafeAreaInsets();
  const [cats, setCats] = useState<CategoryDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const data = await apiFetch<CategoriesResp>(
        `/workspaces/${wsId}/categories`,
      );
      setCats(
        data.categories
          .filter((c) => !c.archivedAt)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  // Fetch every time the sheet opens — categories may have changed
  // (e.g., user created a new one in another screen). Reset transient
  // state on close so reopening starts clean.
  useEffect(() => {
    if (!visible) {
      setQuery("");
      setSaving(null);
      return;
    }
    load();
  }, [visible, load]);

  const pick = async (cat: CategoryDTO | null) => {
    setSaving(cat?.id ?? "__none");
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${txId}`, {
        method: "PATCH",
        body: JSON.stringify({ categoryId: cat?.id ?? null }),
      });
      onChange();
    } catch (e) {
      setSaving(null);
      Alert.alert(
        "Couldn't update category",
        (e as { code?: string }).code ?? "Try again.",
      );
    }
  };

  const items: Item[] = useMemo(() => {
    if (!cats) return [];
    const filtered = query
      ? cats.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
      : cats;
    const rows: Item[] = filtered.map((c) => ({ kind: "cat", cat: c }));
    rows.push({ kind: "none" });
    rows.push({ kind: "create" });
    return rows;
  }, [cats, query]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityLabel="Close category picker"
        />
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <View style={styles.head}>
            <Text style={styles.title}>Choose category</Text>
            <Pressable
              style={({ pressed }) => [
                styles.closeBtn,
                pressed && { opacity: 0.6 },
              ]}
              onPress={onClose}
              accessibilityLabel="Close"
              hitSlop={8}
            >
              <Ionicons name="close" size={22} color={colors.muted} />
            </Pressable>
          </View>

          <View style={styles.search}>
            <Ionicons name="search" size={16} color={colors.muted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search categories"
              placeholderTextColor={colors.muted}
              value={query}
              onChangeText={setQuery}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
            />
          </View>

          {!cats && !err && (
            <View style={styles.fallback}>
              <ActivityIndicator color={colors.primary} />
            </View>
          )}

          {err && (
            <View style={styles.fallback}>
              <Text style={styles.errTitle}>Couldn't load categories</Text>
              <Text style={styles.errBody}>{err}</Text>
              <Pressable style={styles.cta} onPress={load}>
                <Text style={styles.ctaText}>Try again</Text>
              </Pressable>
            </View>
          )}

          {cats && (
            <FlatList
              style={{ flex: 1 }}
              data={items}
              keyExtractor={(item) =>
                item.kind === "cat" ? item.cat.id : item.kind
              }
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={[
                styles.list,
                { paddingBottom: insets.bottom + space.lg },
              ]}
              renderItem={({ item }) => {
                if (item.kind === "none") {
                  const isSel = selectedId == null;
                  const isSaving = saving === "__none";
                  return (
                    <Pressable
                      style={({ pressed }) => [
                        styles.row,
                        pressed && { backgroundColor: colors.surfaceSoft },
                      ]}
                      disabled={!!saving}
                      onPress={() => pick(null)}
                    >
                      <View
                        style={[styles.glyph, { backgroundColor: colors.surfaceSoft }]}
                      >
                        <Ionicons
                          name="help-circle-outline"
                          size={16}
                          color={colors.muted}
                        />
                      </View>
                      <Text style={[styles.name, { color: colors.muted }]}>
                        Uncategorized
                      </Text>
                      {isSaving ? (
                        <ActivityIndicator size="small" color={colors.primary} />
                      ) : isSel ? (
                        <SelectedMark />
                      ) : null}
                    </Pressable>
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
                      onPress={() =>
                        Alert.alert(
                          "Coming soon",
                          "Creating new categories is on the way.",
                        )
                      }
                    >
                      <View
                        style={[styles.glyph, { backgroundColor: colors.surfaceSoft }]}
                      >
                        <Ionicons name="add" size={18} color={colors.ink} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.name}>Create new category</Text>
                        <Text style={styles.sub}>
                          Adds to your workspace for everyone.
                        </Text>
                      </View>
                      <Ionicons
                        name="chevron-forward"
                        size={16}
                        color={colors.mutedSoft}
                      />
                    </Pressable>
                  );
                }
                const c = item.cat;
                const meta = categoryMeta(c);
                const isSel = c.id === selectedId;
                const isSaving = saving === c.id;
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.row,
                      pressed && { backgroundColor: colors.surfaceSoft },
                    ]}
                    disabled={!!saving}
                    onPress={() => pick(c)}
                  >
                    <View style={[styles.glyph, { backgroundColor: meta.bg }]}>
                      <Ionicons name={meta.icon} size={16} color={meta.fg} />
                    </View>
                    <Text style={styles.name}>{c.name}</Text>
                    {isSaving ? (
                      <ActivityIndicator size="small" color={colors.primary} />
                    ) : isSel ? (
                      <SelectedMark />
                    ) : null}
                  </Pressable>
                );
              }}
              ItemSeparatorComponent={() => <View style={styles.sep} />}
              ListHeaderComponent={
                <Text style={styles.groupLabel}>All categories</Text>
              }
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

function SelectedMark() {
  return (
    <View style={styles.selectedMark}>
      <Ionicons name="checkmark" size={14} color={colors.onPrimary} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    height: "90%",
    overflow: "hidden",
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 999,
    backgroundColor: colors.mutedSoft,
    marginTop: 8,
    marginBottom: 4,
  },
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
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.base,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    height: 38,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
  },
  searchInput: {
    flex: 1,
    ...type$.bodyMd,
    color: colors.ink,
    paddingVertical: 0,
  },
  list: { paddingBottom: space.lg },
  fallback: { alignItems: "center", justifyContent: "center", padding: space.xl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base, textAlign: "center" },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },
  groupLabel: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    paddingHorizontal: space.lg,
    paddingTop: space.base,
    paddingBottom: space.xs,
  },
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
    alignItems: "center",
    justifyContent: "center",
  },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", flex: 1 },
  sub: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  sep: { height: 1, backgroundColor: colors.hairlineSoft, marginLeft: 24 + 34 + 12 },
  selectedMark: {
    width: 22,
    height: 22,
    borderRadius: 999,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
});
