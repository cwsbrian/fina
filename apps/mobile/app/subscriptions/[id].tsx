import { useCallback, useEffect, useState } from "react";
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
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Stack, router, useLocalSearchParams } from "expo-router";
import type { CategoryDTO, Cadence } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { CategoryPickerSheet } from "../../src/categories/CategoryPickerSheet";
import { categoryMeta } from "../../src/categories/meta";
import { DatePickerSheet } from "../../src/datetime/DatePickerSheet";

const TEN_YEARS_MS = 10 * 365 * 86_400_000;

const CADENCE_OPTIONS: { value: Cadence; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "semimonthly", label: "Semi-monthly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "weekly", label: "Weekly" },
  { value: "yearly", label: "Annual" },
];

type Recurring = {
  id: string;
  name: string;
  amount: string;
  cadence: Cadence;
  nextOccurrenceDate: string;
  categoryId: string | null;
};

function parseDateOnlyAsLocal(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  const out = new Date();
  out.setFullYear(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  out.setHours(12, 0, 0, 0);
  return out;
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

export default function EditSubscription() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = params.id;

  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [date, setDate] = useState<Date>(() => new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [category, setCategory] = useState<CategoryDTO | null>(null);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const wsId =
          (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
        if (!wsId || !id) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const [list, cats] = await Promise.all([
          apiFetch<{ recurring: Recurring[] }>(
            `/workspaces/${wsId}/recurring`,
          ),
          apiFetch<{ categories: CategoryDTO[] }>(
            `/workspaces/${wsId}/categories`,
          ),
        ]);
        if (cancelled) return;
        const row = list.recurring.find((r) => r.id === id);
        if (!row) {
          setNotFound(true);
          return;
        }
        setName(row.name);
        setAmount(Number(row.amount).toFixed(2));
        setCadence(row.cadence);
        setDate(parseDateOnlyAsLocal(row.nextOccurrenceDate));
        const cat = row.categoryId
          ? cats.categories.find((c) => c.id === row.categoryId) ?? null
          : null;
        setCategory(cat);
        setLoaded(true);
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const save = useCallback(async () => {
    const num = Number(amount);
    const trimmedName = name.trim();
    if (!Number.isFinite(num) || num <= 0 || submitting) return;
    if (trimmedName.length === 0) return;
    setSubmitting(true);
    setErr(null);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      const body: Record<string, unknown> = {
        name: trimmedName,
        amount: num,
        cadence,
        nextOccurrenceDate: toYMD(date),
      };
      if (category) body.categoryId = category.id;
      await apiFetch(`/workspaces/${wsId}/recurring/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "save_failed";
      setErr(
        code === "name_conflict"
          ? "Another subscription already uses that name."
          : `Couldn't save: ${code}`,
      );
      setSubmitting(false);
    }
  }, [name, amount, cadence, date, category, submitting, id]);

  const onDelete = () => {
    Alert.alert(
      `Remove this subscription?`,
      "Future occurrences stop projecting. Past matched transactions stay as-is.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              const wsId = await getActiveWorkspaceId();
              if (!wsId) throw new Error("no_workspace");
              await apiFetch(
                `/workspaces/${wsId}/recurring/${id}`,
                { method: "DELETE" },
              );
              router.back();
            } catch (e) {
              setDeleting(false);
              Alert.alert(
                "Couldn't remove",
                (e as { code?: string }).code ?? "error",
              );
            }
          },
        },
      ],
    );
  };

  if (notFound) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.head}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.cancel}>Back</Text>
          </Pressable>
          <Text style={styles.title}>Subscription</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.notFoundBody}>
          <Text style={styles.notFoundTitle}>Not found</Text>
          <Text style={styles.notFoundSub}>
            This subscription may have been removed.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (!loaded) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.head}>
          <Pressable onPress={() => router.back()} hitSlop={8}>
            <Text style={styles.cancel}>Back</Text>
          </Pressable>
          <Text style={styles.title}>Subscription</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.notFoundBody}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const canSubmit =
    !submitting &&
    !deleting &&
    name.trim().length > 0 &&
    Number.isFinite(Number(amount)) &&
    Number(amount) > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <Pressable
          onPress={() => router.back()}
          disabled={submitting || deleting}
          hitSlop={8}
        >
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>Edit subscription</Text>
        <Pressable onPress={save} disabled={!canSubmit} hitSlop={8}>
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
          <View style={styles.amountRow}>
            <Text style={styles.amountAdornment}>−</Text>
            <Text style={[styles.amountAdornment, { marginRight: 2 }]}>$</Text>
            <View style={styles.amountInputWrap}>
              <TextInput
                style={styles.amountInput}
                value={amount}
                onChangeText={(v) => {
                  if (/^\d*\.?\d{0,2}$/.test(v)) setAmount(v);
                }}
                keyboardType="decimal-pad"
                editable={!submitting && !deleting}
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

          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={(v) => {
              setName(v);
              if (err) setErr(null);
            }}
            placeholder="e.g. Netflix"
            placeholderTextColor={colors.mutedSoft}
            editable={!submitting && !deleting}
            returnKeyType="done"
            maxLength={100}
          />

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
                  disabled={submitting || deleting}
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

          <Pressable
            style={styles.detailRow}
            onPress={() => {
              Keyboard.dismiss();
              setCategoryPickerOpen(true);
            }}
            disabled={submitting || deleting}
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

          <Pressable
            style={styles.detailRow}
            onPress={() => {
              Keyboard.dismiss();
              setShowDatePicker(true);
            }}
            disabled={submitting || deleting}
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

          <Pressable
            style={({ pressed }) => [
              styles.deleteBtn,
              (pressed || deleting) && { opacity: 0.7 },
            ]}
            onPress={onDelete}
            disabled={submitting || deleting}
          >
            {deleting ? (
              <ActivityIndicator size="small" color={colors.down} />
            ) : (
              <>
                <Ionicons name="trash-outline" size={16} color={colors.down} />
                <Text style={styles.deleteBtnText}>Remove subscription</Text>
              </>
            )}
          </Pressable>
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
  amountAdornment: { fontSize: 30, fontWeight: "500", color: colors.ink },
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

  cadenceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
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
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    marginTop: space.xl,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
  },
  deleteBtnText: { ...type$.bodyMd, color: colors.down, fontWeight: "600" },
  notFoundBody: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xl,
  },
  notFoundTitle: { ...type$.titleMd, color: colors.ink, marginBottom: 6 },
  notFoundSub: { ...type$.bodyMd, color: colors.body, textAlign: "center" },
});
