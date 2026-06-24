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
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { TransactionDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../../src/api/client";
import { getActiveWorkspaceId } from "../../../src/workspace/active";
import { colors, space, type as type$ } from "../../../src/design/tokens";

type SingleTxResp = { transaction: TransactionDTO };

export default function EditAmount() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        const n = Number(data.transaction.amount);
        setAmount(Number.isFinite(n) ? Math.abs(n).toFixed(2) : "");
      } catch {
        if (!cancelled) {
          Alert.alert("Couldn't load transaction");
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

  const submit = useCallback(async () => {
    if (!id) return;
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0 || submitting) return;
    const signed = Math.abs(num);
    setSubmitting(true);
    setErr(null);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      await apiFetch(`/workspaces/${wsId}/transactions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ amount: signed }),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "save_failed";
      const status = (e as { status?: number }).status;
      setErr(`Couldn't save: ${code}${status ? ` (HTTP ${status})` : ""}`);
      setSubmitting(false);
    }
  }, [id, amount, submitting]);

  const canSubmit =
    !submitting &&
    !loading &&
    Number.isFinite(Number(amount)) &&
    Number(amount) > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} disabled={submitting} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Amount</Text>
        <Pressable onPress={submit} disabled={!canSubmit} hitSlop={8}>
          {submitting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.save, !canSubmit && { opacity: 0.5 }]}>
              Save
            </Text>
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
          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.body}
          >
            <View style={styles.amountRow}>
              <Text style={styles.adornment}>−</Text>
              <Text style={[styles.adornment, { marginRight: 2 }]}>$</Text>
              <TextInput
                style={styles.amountInput}
                value={amount}
                onChangeText={(v) => {
                  if (/^\d*\.?\d{0,2}$/.test(v)) setAmount(v);
                  if (err) setErr(null);
                }}
                placeholder="0"
                placeholderTextColor={colors.mutedSoft}
                keyboardType="decimal-pad"
                editable={!submitting}
                autoFocus
              />
            </View>

            {err && <Text style={styles.error}>{err}</Text>}
          </ScrollView>
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
  cancel: { ...type$.bodyMd, color: colors.muted },
  save: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center" },
  body: { padding: space.lg, paddingBottom: space.xl },
  seg: {
    flexDirection: "row",
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
    padding: 4,
    marginBottom: space.xl,
  },
  segOpt: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  segActive: { backgroundColor: colors.canvas },
  segText: { ...type$.bodyMd, color: colors.muted, fontWeight: "600" },
  segTextActive: { color: colors.ink },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: space.lg,
  },
  adornment: { fontSize: 30, fontWeight: "500", color: colors.ink },
  amountInput: {
    fontSize: 56,
    fontWeight: "500",
    letterSpacing: -1.6,
    color: colors.ink,
    minWidth: 80,
    paddingTop: 8,
    paddingBottom: 4,
  },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.sm },
});
