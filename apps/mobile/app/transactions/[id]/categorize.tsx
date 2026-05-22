import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../src/api/client";
import { getActiveWorkspaceId } from "../../../src/workspace/active";
import { colors, space, type as type$ } from "../../../src/design/tokens";
import { HeaderIconButton } from "../../../src/design/HeaderIconButton";

type CategoriesResp = { categories: CategoryDTO[] };

export default function CategorizePicker() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [cats, setCats] = useState<CategoryDTO[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const data = await apiFetch<CategoriesResp>(
        `/workspaces/${wsId}/categories`,
      );
      setCats(data.categories.filter((c) => !c.archivedAt));
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const pick = async (cat: CategoryDTO | null) => {
    if (!id) return;
    setSaving(cat?.id ?? "__none");
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ categoryId: cat?.id ?? null }),
      });
      router.back();
    } catch (e) {
      setSaving(null);
      Alert.alert(
        "Couldn't update category",
        (e as { code?: string }).code ?? "Try again.",
      );
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.nav}>
        <HeaderIconButton
          icon="chevron-back"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          variant="plain"
        />
        <Text style={styles.navTitle}>Category</Text>
        <View style={{ width: 34 }} />
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
          data={[{ id: "__none", name: "Uncategorized" } as CategoryDTO, ...cats]}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ paddingVertical: space.sm }}
          renderItem={({ item }) => {
            const isNone = item.id === "__none";
            const isSaving = saving === item.id;
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.row,
                  pressed && { backgroundColor: colors.surfaceSoft },
                ]}
                disabled={!!saving}
                onPress={() => pick(isNone ? null : item)}
              >
                <View style={styles.glyph}>
                  <Ionicons
                    name={isNone ? "help-outline" : "pricetag-outline"}
                    size={16}
                    color={colors.muted}
                  />
                </View>
                <Text style={[styles.name, isNone && { color: colors.muted }]}>
                  {item.name}
                </Text>
                {isSaving && (
                  <ActivityIndicator size="small" color={colors.primary} />
                )}
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={styles.sep} />}
        />
      )}
    </SafeAreaView>
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
  navTitle: { ...type$.titleSm, color: colors.ink },
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: 14,
  },
  glyph: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", flex: 1 },
  sep: { height: 1, backgroundColor: colors.hairlineSoft, marginLeft: 24 + 34 + 12 },
});
