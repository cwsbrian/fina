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
import type { CategoryDTO, Cadence } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { CategoryPickerSheet } from "../../src/categories/CategoryPickerSheet";
import { categoryMeta } from "../../src/categories/meta";
import { DatePickerSheet } from "../../src/datetime/DatePickerSheet";
import { currencySymbol } from "../../src/format/money";
import { useWorkspaceCurrency } from "../../src/workspace/useWorkspaceCurrency";

const TEN_YEARS_MS = 10 * 365 * 86_400_000;

const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "semimonthly", label: "Semi-monthly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "weekly", label: "Weekly" },
  { value: "yearly", label: "Annual" },
];

function todayAt(hours = 12): Date {
  const d = new Date();
  d.setHours(hours, 0, 0, 0);
  return d;
}

function formatDate(d: Date): string {
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return "Today";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year:
      d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

export default function NewSubscription() {
  const currency = useWorkspaceCurrency();
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [date, setDate] = useState<Date>(() => todayAt(12));
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [category, setCategory] = useState<CategoryDTO | null>(null);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const num = Number(amount);
    const trimmedName = name.trim();
    if (!Number.isFinite(num) || num <= 0 || submitting) return;
    if (trimmedName.length === 0) return;
    setSubmitting(true);
    setErr(null);
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const body: Record<string, unknown> = {
        name: trimmedName,
        amount: num,
        cadence,
        nextOccurrenceDate: toYMD(date),
      };
      if (category) body.categoryId = category.id;
      await apiFetch(`/workspaces/${wsId}/recurring`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "create_failed";
      setErr(`Couldn't save: ${code}`);
      setSubmitting(false);
    }
  }, [name, amount, cadence, date, category, submitting]);

  const canSubmit =
    !submitting &&
    name.trim().length > 0 &&
    Number.isFinite(Number(amount)) &&
    Number(amount) > 0;

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
        <Text style={styles.title}>New subscription</Text>
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
        <ScrollView
          style={{ flex: 1 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.body}
        >
          {/* Amount hero */}
          <View style={styles.amountRow}>
            <Text style={styles.amountAdornment}>−</Text>
            <Text style={[styles.amountAdornment, { marginRight: 2 }]}>
              {currencySymbol(currency)}
            </Text>
            <View style={styles.amountInputWrap}>
              <TextInput
                style={styles.amountInput}
                value={amount}
                onChangeText={(v) => {
                  if (/^\d*\.?\d{0,2}$/.test(v)) setAmount(v);
                }}
                keyboardType="decimal-pad"
                editable={!submitting}
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

          {/* Name */}
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={(v) => {
              setName(v);
              if (err) setErr(null);
            }}
            placeholder="e.g. Netflix, Spotify, Rent"
            placeholderTextColor={colors.mutedSoft}
            editable={!submitting}
            returnKeyType="done"
            maxLength={100}
            autoFocus
          />

          {/* Cadence */}
          <Text style={styles.label}>Cadence</Text>
          <View style={styles.cadenceGrid}>
            {CADENCE_OPTIONS.map((opt) => {
              const active = cadence === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  style={[
                    styles.cadenceChip,
                    active && styles.cadenceChipActive,
                  ]}
                  onPress={() => setCadence(opt.value)}
                  disabled={submitting}
                >
                  <Text
                    style={[
                      styles.cadenceChipText,
                      active && styles.cadenceChipTextActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

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
              {category?.name ?? "Optional"}
            </Text>
          </Pressable>

          {/* Next date */}
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
            <Text style={styles.detailRowLabel}>Next billing</Text>
            <Text style={styles.detailRowValue}>{formatDate(date)}</Text>
          </Pressable>

          {err && <Text style={styles.error}>{err}</Text>}

          <Text style={styles.helper}>
            Fina projects future occurrences from the next billing date and
            counts them in your budget. Long-press a subscription to remove it.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>

      <DatePickerSheet
        visible={showDatePicker}
        value={date}
        mode="date"
        maximumDate={new Date(Date.now() + TEN_YEARS_MS)}
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
    marginTop: space.lg,
  },
  input: {
    ...type$.bodyMd,
    color: colors.ink,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
  },

  cadenceGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  cadenceChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
  },
  cadenceChipActive: { backgroundColor: colors.ink },
  cadenceChipText: { ...type$.bodySm, color: colors.body, fontWeight: "600" },
  cadenceChipTextActive: { color: colors.canvas },

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
