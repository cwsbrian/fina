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
import DateTimePicker from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { Stack, router } from "expo-router";
import type { CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { CategoryPickerSheet } from "../../src/categories/CategoryPickerSheet";
import { categoryMeta } from "../../src/categories/meta";

type Kind = "expense" | "income";

export default function NewTransaction() {
  const [kind, setKind] = useState<Kind>("expense");
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState<Date>(() => new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [category, setCategory] = useState<CategoryDTO | null>(null);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
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
      // Plaid convention: amount positive = spend (expense), negative =
      // credit (income). The activity formatter reads the sign to color
      // and prefix the row.
      const signed = kind === "income" ? -Math.abs(num) : Math.abs(num);
      // Backend expects YYYY-MM-DD (validators.parseOccurredAt).
      const occurredAt = `${date.getFullYear()}-${String(
        date.getMonth() + 1,
      ).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      await apiFetch(`/workspaces/${wsId}/transactions/manual`, {
        method: "POST",
        body: JSON.stringify({
          merchantRaw: trimmedMerchant,
          amount: signed,
          occurredAt,
          ...(category ? { categoryId: category.id } : {}),
        }),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "create_failed";
      const status = (e as { status?: number }).status;
      setErr(
        code === "no_account"
          ? "Add an account before logging manual transactions."
          : `Couldn't save: ${code}${status ? ` (HTTP ${status})` : ""}`,
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
                styles.amountAdornment,
                kind === "income" && { color: colors.up },
              ]}
            >
              {kind === "income" ? "+" : "−"}
            </Text>
            <Text
              style={[
                styles.amountAdornment,
                kind === "income" && { color: colors.up },
                { marginRight: 2 },
              ]}
            >
              $
            </Text>
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

          {/* Date */}
          <Pressable
            style={styles.detailRow}
            onPress={() => setShowDatePicker(true)}
            disabled={submitting}
          >
            <View style={styles.detailRowIcon}>
              <Ionicons
                name="calendar-outline"
                size={18}
                color={colors.muted}
              />
            </View>
            <Text style={styles.detailRowLabel}>Date</Text>
            <Text style={styles.detailRowValue}>{formatDate(date)}</Text>
          </Pressable>

          {/* Category */}
          <Pressable
            style={styles.detailRow}
            onPress={() => setCategoryPickerOpen(true)}
            disabled={submitting}
          >
            {category ? (
              <View
                style={[
                  styles.detailRowIcon,
                  { backgroundColor: categoryMeta(category).bg },
                ]}
              >
                <Ionicons
                  name={categoryMeta(category).icon}
                  size={16}
                  color={categoryMeta(category).fg}
                />
              </View>
            ) : (
              <View style={styles.detailRowIcon}>
                <Ionicons
                  name="pricetag-outline"
                  size={18}
                  color={colors.muted}
                />
              </View>
            )}
            <Text style={styles.detailRowLabel}>Category</Text>
            <Text
              style={[
                styles.detailRowValue,
                !category && { color: colors.mutedSoft },
              ]}
            >
              {category?.name ?? "Choose"}
            </Text>
          </Pressable>

          {err && <Text style={styles.error}>{err}</Text>}

          <Text style={styles.helper}>
            Account and notes can be edited on the transaction after you save.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      {showDatePicker && (
        <DateTimePicker
          value={date}
          mode="date"
          display={Platform.OS === "ios" ? "inline" : "default"}
          onChange={(_, selected) => {
            // Android dismisses the picker on each selection; iOS keeps
            // it open inline. Either way, the user has picked once we
            // get a non-undefined value — close on iOS via the Done CTA
            // (we render with `inline` so the user dismisses by tapping
            // outside / Cancel; here we just record the new value).
            if (Platform.OS === "android") setShowDatePicker(false);
            if (selected) setDate(selected);
          }}
        />
      )}

      <CategoryPickerSheet
        visible={categoryPickerOpen}
        selectedId={category?.id ?? null}
        onClose={() => setCategoryPickerOpen(false)}
        onSelect={(cat) => {
          setCategory(cat);
          setCategoryPickerOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

function formatDate(d: Date): string {
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = d.getDate();
  return sameDay
    ? `Today, ${month} ${day}`
    : `${month} ${day}, ${d.getFullYear()}`;
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
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: space.lg,
    marginBottom: space.lg,
  },
  amountAdornment: {
    fontSize: 30,
    fontWeight: "500",
    color: colors.ink,
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
  },
  input: {
    ...type$.bodyMd,
    color: colors.ink,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
    marginBottom: space.lg,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  detailRowIcon: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  detailRowLabel: { ...type$.bodyMd, color: colors.ink, flex: 1 },
  detailRowValue: { ...type$.bodyMd, color: colors.body },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.sm },
  helper: {
    ...type$.bodySm,
    color: colors.muted,
    marginTop: space.lg,
    textAlign: "center",
  },
});
