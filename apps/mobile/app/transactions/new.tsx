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
  Keyboard,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, router } from "expo-router";
import type { CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { CategoryPickerSheet } from "../../src/categories/CategoryPickerSheet";
import { categoryMeta } from "../../src/categories/meta";
import { DatePickerSheet } from "../../src/datetime/DatePickerSheet";

export default function NewTransaction() {
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
      const signed = Math.abs(num);
      // ISO instant — backend's parseOccurredAt accepts either YYYY-MM-DD
      // (legacy) or a full ISO 8601 with tz, which preserves the time.
      const occurredAt = date.toISOString();
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
  }, [amount, merchant, submitting]);

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
          {/* Amount hero */}
          <View style={styles.amountRow}>
            <Text style={styles.amountAdornment}>−</Text>
            <Text style={[styles.amountAdornment, { marginRight: 2 }]}>$</Text>
            <View style={styles.amountInputWrap}>
              <TextInput
                style={styles.amountInput}
                value={amount}
                onChangeText={(v) => {
                  // Allow digits + a single decimal point with up to 2 dp.
                  if (/^\d*\.?\d{0,2}$/.test(v)) setAmount(v);
                }}
                keyboardType="decimal-pad"
                editable={!submitting}
                autoFocus
              />
              {!amount && (
                <Text
                  pointerEvents="none"
                  style={[styles.amountInput, styles.amountPlaceholder]}
                >
                  0
                </Text>
              )}
            </View>
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
            onPress={() => {
              Keyboard.dismiss();
              setShowDatePicker(true);
            }}
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
            onPress={() => {
              Keyboard.dismiss();
              setCategoryPickerOpen(true);
            }}
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

      <DatePickerSheet
        visible={showDatePicker}
        value={date}
        mode="datetime"
        onClose={() => setShowDatePicker(false)}
        onConfirm={(next) => {
          setDate(next);
          setShowDatePicker(false);
        }}
      />

      <CategoryPickerSheet
        visible={categoryPickerOpen}
        selectedId={category?.id ?? null}
        categoryType="expense"
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
  const time = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return sameDay
    ? `Today, ${time}`
    : `${month} ${day}, ${d.getFullYear()} · ${time}`;
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
  amountInputWrap: { position: "relative", justifyContent: "center" },
  amountInput: {
    fontSize: 56,
    fontWeight: "500",
    letterSpacing: -1.6,
    color: colors.ink,
    minWidth: 80,
    paddingTop: 8,
    paddingBottom: 4,
  },
  amountPlaceholder: {
    position: "absolute",
    left: 0,
    top: 0,
    color: colors.mutedSoft,
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
