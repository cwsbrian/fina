import { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { hasAtLeast, type CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspaceSummary } from "../../src/api/client";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { categoryMeta, withAlpha } from "../../src/categories/meta";

export default function CategoriesScreen() {
  const [cats, setCats] = useState<CategoryDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [canManage, setCanManage] = useState(false);

  const load = useCallback(async () => {
    try {
      const workspace = await bootstrapActiveWorkspaceSummary();
      if (!workspace) throw new Error("no_workspace");
      setCanManage(hasAtLeast(workspace.role, "editor"));
      const data = await apiFetch<{ categories: CategoryDTO[] }>(
        `/workspaces/${workspace.id}/categories`,
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

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  const visible = useMemo(
    () => (cats ?? []).filter((c) => c.type === "expense"),
    [cats],
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <HeaderIconButton icon="chevron-back" onPress={() => router.back()} variant="plain" />
        <Text style={styles.title}>Categories</Text>
        {canManage ? (
          <HeaderIconButton
            icon="add"
            variant="plain"
            accessibilityLabel="Add category"
            onPress={() => router.push("/categories/new?type=expense" as never)}
          />
        ) : (
          <View style={styles.headerSlot} />
        )}
      </View>

      {cats === null && !err && (
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

      {cats && !err && (
        <ScrollView
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          {visible.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No categories yet</Text>
              {canManage && (
                <Text style={styles.emptyBody}>Tap + to add your first one.</Text>
              )}
            </View>
          ) : (
            visible.map((c) => <Row key={c.id} cat={c} canManage={canManage} />)
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function Row({ cat, canManage }: { cat: CategoryDTO; canManage: boolean }) {
  const meta = categoryMeta(cat);
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
      disabled={!canManage}
      onPress={canManage ? () => router.push(`/categories/${cat.id}/edit` as never) : undefined}
    >
      <View
        style={[styles.glyph, { backgroundColor: withAlpha(meta.fg, 0.14) }]}
      >
        <Ionicons name={meta.icon} size={18} color={meta.fg} />
      </View>
      <Text style={styles.rowName} numberOfLines={1}>
        {cat.name}
      </Text>
      {canManage && (
        <Ionicons name="chevron-forward" size={18} color={colors.mutedSoft} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  title: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  headerSlot: { width: 34, height: 34 },
  list: { paddingHorizontal: space.lg, paddingBottom: space.xl },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  glyph: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  rowName: { ...type$.bodyMd, color: colors.ink, flex: 1 },
  empty: { alignItems: "center", paddingVertical: space.xl * 2 },
  emptyTitle: { ...type$.titleSm, color: colors.ink, marginBottom: 6 },
  emptyBody: { ...type$.bodySm, color: colors.muted, textAlign: "center" },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  errTitle: { ...type$.titleSm, color: colors.ink, marginBottom: 6 },
  errBody: { ...type$.bodySm, color: colors.muted, marginBottom: space.base, textAlign: "center" },
  cta: {
    paddingHorizontal: space.lg,
    paddingVertical: 10,
    backgroundColor: colors.primary,
    borderRadius: 10,
  },
  ctaText: { ...type$.bodyMd, color: "#fff", fontWeight: "600" },
});
