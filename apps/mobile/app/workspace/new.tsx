import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { apiFetch } from "../../src/api/client";
import { setActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";

const CURRENCIES = [
  { code: "CAD", label: "CAD · $" },
  { code: "USD", label: "USD · $" },
  { code: "EUR", label: "EUR · €" },
  { code: "GBP", label: "GBP · £" },
  { code: "KRW", label: "KRW · ₩" },
  { code: "JPY", label: "JPY · ¥" },
];

type CreateResp = {
  workspace: { id: string; name: string; currency: string };
};

export default function NewWorkspace() {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("CAD");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trimmed = name.trim();
  const canSubmit = !submitting && trimmed.length > 0 && trimmed.length <= 80;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setErr(null);
    try {
      const r = await apiFetch<CreateResp>("/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, currency }),
      });
      // Make the new workspace active so the tabs reload against it.
      await setActiveWorkspaceId(r.workspace.id);
      router.replace("/(tabs)" as never);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "create_failed");
      setSubmitting(false);
    }
  }, [canSubmit, trimmed, currency]);

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
        <Text style={styles.title}>New workspace</Text>
        <Pressable onPress={submit} disabled={!canSubmit} hitSlop={8}>
          {submitting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.save, !canSubmit && { opacity: 0.5 }]}>
              Create
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
          <Text style={styles.sub}>
            A new workspace is its own world — separate categories, accounts,
            budgets, and members. Useful for a side business or another
            household.
          </Text>

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={(v) => {
              setName(v);
              if (err) setErr(null);
            }}
            placeholder="e.g. Choi family, Side hustle"
            placeholderTextColor={colors.mutedSoft}
            editable={!submitting}
            returnKeyType="done"
            maxLength={80}
            autoFocus
          />

          <Text style={[styles.label, { marginTop: space.lg }]}>Currency</Text>
          <View style={styles.chips}>
            {CURRENCIES.map((c) => {
              const active = currency === c.code;
              return (
                <Pressable
                  key={c.code}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => setCurrency(c.code)}
                  disabled={submitting}
                >
                  <Text
                    style={[
                      styles.chipText,
                      active && styles.chipTextActive,
                    ]}
                  >
                    {c.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.helper}>
            <Ionicons
              name="information-circle-outline"
              size={14}
              color={colors.muted}
              style={{ marginTop: 2 }}
            />
            <Text style={styles.helperText}>
              You'll start as the owner. Default categories and a manual
              account are seeded automatically. You can invite members after
              creating.
            </Text>
          </View>

          {err && (
            <Text style={styles.error}>
              {err === "invalid_body"
                ? "Pick a name between 1 and 80 characters."
                : `Couldn't create: ${err}`}
            </Text>
          )}
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
  sub: { ...type$.bodyMd, color: colors.body, marginBottom: space.lg },
  label: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: space.xs,
  },
  input: {
    ...type$.bodyMd,
    color: colors.ink,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
  },
  chipActive: { backgroundColor: colors.ink },
  chipText: { ...type$.bodySm, color: colors.body, fontWeight: "600" },
  chipTextActive: { color: colors.canvas },

  helper: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    marginTop: space.lg,
    paddingHorizontal: 4,
  },
  helperText: { ...type$.bodySm, color: colors.muted, flex: 1 },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.base },
});
