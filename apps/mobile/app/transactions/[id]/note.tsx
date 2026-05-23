import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { TransactionDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../src/api/client";
import { getActiveWorkspaceId } from "../../../src/workspace/active";
import { colors, space, type as type$ } from "../../../src/design/tokens";

type SingleTxResp = { transaction: TransactionDTO };

export default function EditNote() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [original, setOriginal] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load the current note so the editor opens pre-populated. We fetch
  // instead of passing through params so a stale value can't ship if the
  // tx was edited elsewhere between detail mount + this push.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const wsId =
          (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
        if (!wsId) throw new Error("no_workspace");
        const data = await apiFetch<SingleTxResp>(
          `/workspaces/${wsId}/transactions/${id}`,
        );
        if (cancelled) return;
        setOriginal(data.transaction.note);
        setDraft(data.transaction.note ?? "");
      } catch (e) {
        if (!cancelled) {
          Alert.alert(
            "Couldn't load note",
            (e as { code?: string }).code ?? "Try again.",
          );
          router.back();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const save = useCallback(async () => {
    if (!id || saving) return;
    const trimmed = draft.trim();
    const next: string | null = trimmed.length === 0 ? null : trimmed;
    if (next === original) {
      router.back();
      return;
    }
    setSaving(true);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ note: next }),
      });
      router.back();
    } catch (e) {
      Alert.alert(
        "Couldn't save note",
        (e as { code?: string }).code ?? "Try again.",
      );
      setSaving(false);
    }
  }, [id, draft, original, saving]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <Pressable
          style={({ pressed }) => [
            styles.actionBtn,
            pressed && { opacity: 0.6 },
          ]}
          onPress={() => router.back()}
          disabled={saving}
          hitSlop={8}
        >
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Note</Text>
        <Pressable
          style={({ pressed }) => [
            styles.actionBtn,
            (pressed || saving) && { opacity: 0.6 },
          ]}
          onPress={save}
          disabled={saving || loading}
          hitSlop={8}
        >
          {saving ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.save}>Save</Text>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {loading ? (
          <View style={styles.fallback}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={setDraft}
            placeholder="Add a note"
            placeholderTextColor={colors.mutedSoft}
            multiline
            editable={!saving}
            autoFocus
            textAlignVertical="top"
          />
        )}
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
  actionBtn: { minWidth: 60, alignItems: "center", justifyContent: "center" },
  cancel: { ...type$.bodyMd, color: colors.muted },
  save: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  input: {
    flex: 1,
    ...type$.bodyMd,
    color: colors.ink,
    padding: space.lg,
  },
});
