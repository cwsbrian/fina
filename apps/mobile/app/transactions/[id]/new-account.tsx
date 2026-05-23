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
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { BankAccountDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../src/api/client";
import { getActiveWorkspaceId } from "../../../src/workspace/active";
import { colors, space, type as type$ } from "../../../src/design/tokens";

// Friendly type presets the user picks from. Each maps to a Plaid-ish
// `type` string we persist on the BankAccount row (server already
// defaults to "depository" when omitted).
const TYPE_PRESETS: ReadonlyArray<{
  label: string;
  type: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  { label: "Cash",     type: "depository", icon: "cash-outline" },
  { label: "Debit",    type: "depository", icon: "card-outline" },
  { label: "Checking", type: "depository", icon: "wallet-outline" },
  { label: "Credit",   type: "credit",     icon: "card-outline" },
  { label: "Loan",     type: "loan",       icon: "document-text-outline" },
  { label: "Other",    type: "depository", icon: "ellipsis-horizontal" },
];

export default function NewAccount() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [name, setName] = useState("");
  const [presetIdx, setPresetIdx] = useState(0);
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
      const preset = TYPE_PRESETS[presetIdx]!;
      const resp = await apiFetch<{ account: BankAccountDTO }>(
        `/workspaces/${wsId}/accounts`,
        {
          method: "POST",
          body: JSON.stringify({ name: trimmed, type: preset.type }),
        },
      );
      // Auto-assign the new account to the current tx so the user
      // doesn't have to reopen the picker.
      await apiFetch(`/workspaces/${wsId}/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ accountId: resp.account.id }),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "save_failed";
      const status = (e as { status?: number }).status;
      setErr(`Couldn't save: ${code}${status ? ` (HTTP ${status})` : ""}`);
      setSubmitting(false);
    }
  }, [id, name, presetIdx, submitting]);

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
        <Text style={styles.title}>Add account</Text>
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
            <View style={styles.previewGlyph}>
              <Ionicons
                name={TYPE_PRESETS[presetIdx]!.icon}
                size={22}
                color={colors.muted}
              />
            </View>
            <Text
              style={[
                styles.previewName,
                !name.trim() && { color: colors.mutedSoft },
              ]}
              numberOfLines={1}
            >
              {name.trim() || "Account name"}
            </Text>
          </View>

          <TextInput
            style={styles.input}
            value={name}
            onChangeText={(v) => {
              setName(v);
              if (err) setErr(null);
            }}
            placeholder="Name (e.g. Wallet)"
            placeholderTextColor={colors.mutedSoft}
            autoFocus
            editable={!submitting}
            returnKeyType="done"
            onSubmitEditing={submit}
            maxLength={80}
          />

          <Text style={styles.pickerLabel}>Type</Text>
          <View style={styles.typeGrid}>
            {TYPE_PRESETS.map((p, i) => {
              const isSel = i === presetIdx;
              return (
                <Pressable
                  key={p.label}
                  onPress={() => setPresetIdx(i)}
                  style={[styles.typeChip, isSel && styles.typeChipActive]}
                >
                  <Ionicons
                    name={p.icon}
                    size={16}
                    color={isSel ? colors.onPrimary : colors.muted}
                  />
                  <Text
                    style={[
                      styles.typeChipText,
                      isSel && { color: colors.onPrimary },
                    ]}
                  >
                    {p.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

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
    backgroundColor: colors.surfaceSoft,
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
  typeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  typeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: space.base,
    paddingVertical: 10,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
  },
  typeChipActive: { backgroundColor: colors.primary },
  typeChipText: {
    ...type$.bodySm,
    color: colors.ink,
    fontWeight: "600",
  },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.sm },
});
