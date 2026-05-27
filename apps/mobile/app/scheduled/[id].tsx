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
import type { CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { CategoryPickerSheet } from "../../src/categories/CategoryPickerSheet";
import { categoryMeta } from "../../src/categories/meta";
import { DatePickerSheet } from "../../src/datetime/DatePickerSheet";

const TEN_YEARS_MS = 10 * 365 * 86_400_000;

type Schedule = {
  id: string;
  categoryId: string;
  amount: string;
  scheduledDate: string;
  note: string | null;
  matchedTxId: string | null;
  dismissedAt: string | null;
  status:
    | "upcoming"
    | "unresolved"
    | "resolved-matched"
    | "resolved-dismissed";
};

function parseDateOnlyAsLocal(ymd: string): Date {
  // The picker drives a local-time Date; build one anchored to noon
  // local on the YMD so DST shifts don't flip the day.
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

export default function EditScheduled() {
  const params = useLocalSearchParams<{ id: string }>();
  const id = params.id;

  const [loaded, setLoaded] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [status, setStatus] =
    useState<Schedule["status"]>("upcoming");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
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
          apiFetch<{ schedules: Schedule[] }>(
            `/workspaces/${wsId}/schedules`,
          ),
          apiFetch<{ categories: CategoryDTO[] }>(
            `/workspaces/${wsId}/categories`,
          ),
        ]);
        if (cancelled) return;
        const row = list.schedules.find((s) => s.id === id);
        if (!row) {
          setNotFound(true);
          return;
        }
        setStatus(row.status);
        setAmount(Number(row.amount).toFixed(2));
        setNote(row.note ?? "");
        setDate(parseDateOnlyAsLocal(row.scheduledDate));
        const cat =
          cats.categories.find((c) => c.id === row.categoryId) ?? null;
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
    if (!Number.isFinite(num) || num <= 0 || submitting || !category) return;
    setSubmitting(true);
    setErr(null);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      const trimmedNote = note.trim();
      const body: Record<string, unknown> = {
        categoryId: category.id,
        amount: num,
        scheduledDate: toYMD(date),
      };
      if (trimmedNote.length > 0) body.note = trimmedNote;
      await apiFetch(`/workspaces/${wsId}/schedules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "save_failed";
      setErr(`Couldn't save: ${code}`);
      setSubmitting(false);
    }
  }, [amount, note, date, category, submitting, id]);

  const onDelete = () => {
    Alert.alert(
      "Delete this scheduled spend?",
      "It's removed from your projections. You can re-create it anytime.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              const wsId = await getActiveWorkspaceId();
              if (!wsId) throw new Error("no_workspace");
              await apiFetch(
                `/workspaces/${wsId}/schedules/${id}`,
                { method: "DELETE" },
              );
              router.back();
            } catch (e) {
              setDeleting(false);
              Alert.alert(
                "Couldn't delete",
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
          <Text style={styles.title}>Scheduled</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.notFoundBody}>
          <Text style={styles.notFoundTitle}>Not found</Text>
          <Text style={styles.notFoundSub}>
            This scheduled spend may have been deleted.
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
          <Text style={styles.title}>Scheduled</Text>
          <View style={{ width: 40 }} />
        </View>
        <View style={styles.notFoundBody}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const readonly = status === "resolved-matched";
  const canSubmit =
    !readonly &&
    !submitting &&
    !deleting &&
    !!category &&
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
        <Text style={styles.title}>Edit scheduled</Text>
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
          {readonly && (
            <View style={styles.banner}>
              <Ionicons
                name="checkmark-circle"
                size={16}
                color={colors.up}
              />
              <Text style={styles.bannerText}>
                Already matched to a real transaction. Fields are
                read-only. Delete this to detach.
              </Text>
            </View>
          )}

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
                editable={!submitting && !deleting && !readonly}
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

          <Pressable
            style={styles.detailRow}
            onPress={() => {
              Keyboard.dismiss();
              setCategoryPickerOpen(true);
            }}
            disabled={submitting || deleting || readonly}
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

          <Pressable
            style={styles.detailRow}
            onPress={() => {
              Keyboard.dismiss();
              setShowDatePicker(true);
            }}
            disabled={submitting || deleting || readonly}
          >
            <View style={styles.detailRowIcon}>
              <Ionicons
                name="calendar-outline"
                size={18}
                color={colors.muted}
              />
            </View>
            <Text style={styles.detailRowLabel}>When</Text>
            <Text style={styles.detailRowValue}>{formatDate(date)}</Text>
          </Pressable>

          <Text style={styles.label}>Note (optional)</Text>
          <TextInput
            style={styles.input}
            value={note}
            onChangeText={(v) => {
              setNote(v);
              if (err) setErr(null);
            }}
            placeholder="e.g. Dentist cleaning"
            placeholderTextColor={colors.mutedSoft}
            editable={!submitting && !deleting && !readonly}
            returnKeyType="done"
            maxLength={200}
          />

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
                <Text style={styles.deleteBtnText}>Delete</Text>
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
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    padding: 12,
    marginBottom: space.lg,
  },
  bannerText: { ...type$.bodySm, color: colors.body, flex: 1 },

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
  notFoundSub: {
    ...type$.bodyMd,
    color: colors.body,
    textAlign: "center",
  },
});
