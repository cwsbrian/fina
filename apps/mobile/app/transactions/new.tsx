import { useCallback, useState } from "react";
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
import { Stack, router } from "expo-router";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";

type Kind = "expense" | "income";

export default function NewTransaction() {
  const [kind, setKind] = useState<Kind>("expense");
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const num = Number(amount);
    if (!Number.isFinite(num) || num <= 0 || submitting) return;
    const trimmedMerchant = merchant.trim();
    if (trimmedMerchant.length === 0) return;
    setSubmitting(true);
    setErr(null);
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      // Expense → negative; Income → positive. Backend stores signed
      // decimals; the activity row formatter flips the sign for display.
      const signed = kind === "expense" ? -Math.abs(num) : Math.abs(num);
      await apiFetch(`/workspaces/${wsId}/transactions`, {
        method: "POST",
        body: JSON.stringify({
          merchantRaw: trimmedMerchant,
          amount: signed,
        }),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "create_failed";
      setErr(
        code === "no_account"
          ? "Add an account before logging manual transactions."
          : "Couldn't save. Try again.",
      );
      setSubmitting(false);
    }
  }, [amount, merchant, kind, submitting]);

  const canSubmit =
    !submitting &&
    merchant.trim().length > 0 &&
    Number.isFinite(Number(amount)) &&
    Number(amount) > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} disabled={submitting} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>New transaction</Text>
        <Pressable onPress={submit} disabled={!canSubmit} hitSlop={8}>
          {submitting ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={[styles.save, !canSubmit && { opacity: 0.5 }]}>Save</Text>
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
          {/* Type segmented */}
          <View style={styles.seg}>
            <Pressable
              style={[styles.segOpt, kind === "expense" && styles.segActive]}
              onPress={() => setKind("expense")}
              disabled={submitting}
            >
              <Text
                style={[
                  styles.segText,
                  kind === "expense" && styles.segTextActive,
                ]}
              >
                Expense
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.segOpt,
                kind === "income" && [styles.segActive, styles.segActiveIncome],
              ]}
              onPress={() => setKind("income")}
              disabled={submitting}
            >
              <Text
                style={[
                  styles.segText,
                  kind === "income" && styles.segTextActive,
                ]}
              >
                Income
              </Text>
            </Pressable>
          </View>

          {/* Amount hero */}
          <View style={styles.amountRow}>
            <Text
              style={[
                styles.amountSign,
                kind === "income" && { color: colors.up },
              ]}
            >
              {kind === "income" ? "+" : "−"}
            </Text>
            <Text style={styles.amountCurrency}>$</Text>
            <TextInput
              style={[
                styles.amountInput,
                kind === "income" && { color: colors.up },
              ]}
              value={amount}
              onChangeText={(v) => {
                // Allow digits + a single decimal point with up to 2 dp.
                if (/^\d*\.?\d{0,2}$/.test(v)) setAmount(v);
              }}
              placeholder="0"
              placeholderTextColor={colors.mutedSoft}
              keyboardType="decimal-pad"
              editable={!submitting}
              autoFocus
            />
          </View>

          {/* Merchant */}
          <Text style={styles.label}>Merchant</Text>
          <TextInput
            style={styles.input}
            value={merchant}
            onChangeText={(v) => {
              setMerchant(v);
              if (err) setErr(null);
            }}
            placeholder="e.g. Whole Foods"
            placeholderTextColor={colors.mutedSoft}
            editable={!submitting}
            returnKeyType="done"
            maxLength={120}
          />

          {err && <Text style={styles.error}>{err}</Text>}

          <Text style={styles.helper}>
            Category, account, date, and notes can be edited on the transaction
            after you save.
          </Text>
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
  segActiveIncome: {},
  segText: { ...type$.bodyMd, color: colors.muted, fontWeight: "600" },
  segTextActive: { color: colors.ink },

  amountRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    paddingVertical: space.lg,
    marginBottom: space.lg,
  },
  amountSign: {
    fontSize: 38,
    fontWeight: "500",
    color: colors.ink,
    marginBottom: 4,
  },
  amountCurrency: {
    fontSize: 28,
    fontWeight: "500",
    color: colors.ink,
    marginRight: 2,
    marginBottom: 6,
  },
  amountInput: {
    fontSize: 56,
    fontWeight: "500",
    letterSpacing: -1.6,
    color: colors.ink,
    minWidth: 80,
    paddingTop: 8,
    paddingBottom: 4,
  },

  label: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: space.xs,
    textAlign: "center",
  },
  input: {
    ...type$.bodyMd,
    color: colors.ink,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
    textAlign: "center",
  },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.sm },
  helper: {
    ...type$.bodySm,
    color: colors.muted,
    marginTop: space.lg,
    textAlign: "center",
  },
});
