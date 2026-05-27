import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../src/api/client";
import { getActiveWorkspaceId } from "../../../src/workspace/active";
import { colors, space, type as type$ } from "../../../src/design/tokens";
import {
  CATEGORY_COLOR_CHOICES,
  CATEGORY_ICON_CHOICES,
  DEFAULT_NEW_CATEGORY_ICON,
  pickRandomCategoryColor,
  withAlpha,
} from "../../../src/categories/meta";

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export default function NewCategory() {
  const { id, type } = useLocalSearchParams<{
    id: string;
    type?: "expense" | "income";
  }>();
  const categoryType: "expense" | "income" =
    type === "income" ? "income" : "expense";
  const [name, setName] = useState("");
  const [icon, setIcon] = useState(DEFAULT_NEW_CATEGORY_ICON);
  const [color, setColor] = useState(() => pickRandomCategoryColor());
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(async () => {
    if (!id) return;
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const resp = await apiFetch<{ category: CategoryDTO }>(
        `/workspaces/${wsId}/categories`,
        {
          method: "POST",
          body: JSON.stringify({
            name: trimmed,
            type: categoryType,
            icon,
            color,
          }),
        },
      );
      // Auto-assign the new category to the transaction so the user
      // doesn't have to reopen the picker to pick what they just made.
      await apiFetch(`/workspaces/${wsId}/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ categoryId: resp.category.id }),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "create_failed";
      setErr(
        code === "duplicate_name"
          ? "A category with this name already exists."
          : code === "too_many_categories"
            ? "You've reached the 30-category limit."
            : `Couldn't create category (${code}). Try again.`,
      );
      setSubmitting(false);
    }
  }, [id, name, icon, color, categoryType, submitting]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <Pressable
          onPress={() => router.back()}
          disabled={submitting}
          hitSlop={8}
        >
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>
          {categoryType === "income" ? "Add income category" : "Add category"}
        </Text>
        <Pressable
          onPress={submit}
          disabled={submitting || name.trim().length === 0}
          hitSlop={8}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text
              style={[
                styles.save,
                (submitting || name.trim().length === 0) && { opacity: 0.5 },
              ]}
            >
              Save
            </Text>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.body}
        >
          <View style={styles.previewRow}>
            <View
              style={[
                styles.previewGlyph,
                { backgroundColor: withAlpha(color, 0.14) },
              ]}
            >
              <Ionicons name={icon} size={22} color={color} />
            </View>
            <Text
              style={[
                styles.previewName,
                !name.trim() && { color: colors.mutedSoft },
              ]}
              numberOfLines={1}
            >
              {name.trim() || "Category name"}
            </Text>
          </View>

          <TextInput
            style={styles.input}
            value={name}
            onChangeText={(v) => {
              setName(v);
              if (err) setErr(null);
            }}
            placeholder="Name"
            placeholderTextColor={colors.mutedSoft}
            autoFocus
            editable={!submitting}
            returnKeyType="done"
            onSubmitEditing={submit}
            maxLength={40}
          />

          <Text style={styles.pickerLabel}>Color</Text>
          {chunk(CATEGORY_COLOR_CHOICES, 7).map((row, ri) => (
            <View key={ri} style={styles.gridRow}>
              {row.map((c) => {
                const isSel = c === color;
                return (
                  <Pressable
                    key={c}
                    onPress={() => setColor(c)}
                    style={[
                      styles.colorChip,
                      { backgroundColor: c },
                      isSel && styles.colorChipActive,
                    ]}
                  >
                    {isSel && (
                      <Ionicons name="checkmark" size={16} color="#fff" />
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))}

          <Text style={[styles.pickerLabel, { marginTop: space.base }]}>Icon</Text>
          {chunk(CATEGORY_ICON_CHOICES, 5).map((row, ri) => (
            <View key={ri} style={styles.gridRow}>
              {row.map((i) => {
                const isSel = i === icon;
                return (
                  <Pressable
                    key={i}
                    onPress={() => setIcon(i)}
                    style={[styles.iconChip, isSel && { borderColor: color }]}
                  >
                    <Ionicons
                      name={i}
                      size={20}
                      color={isSel ? color : colors.muted}
                    />
                  </Pressable>
                );
              })}
            </View>
          ))}

          {err && <Text style={styles.error}>{err}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
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
  cancel: { ...type$.bodyMd, color: colors.muted },
  save: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  body: { padding: space.lg, paddingBottom: space.xl },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    marginBottom: space.lg,
  },
  previewGlyph: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  previewName: { ...type$.titleMd, color: colors.ink, flex: 1, flexShrink: 1 },
  input: {
    ...type$.bodyMd,
    color: colors.ink,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
    marginBottom: space.lg,
  },
  pickerLabel: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: space.xs,
  },
  gridRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  iconChip: {
    width: 56,
    height: 56,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorChip: {
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorChipActive: { borderColor: colors.ink },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.sm },
});
