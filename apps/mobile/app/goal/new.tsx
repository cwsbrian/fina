import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { GoalDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { DatePickerSheet } from "../../src/datetime/DatePickerSheet";
import {
  DEFAULT_GOAL_ICON,
  GOAL_COLOR_CHOICES,
  GOAL_ICON_CHOICES,
  randomGoalColor,
  withAlpha,
} from "../../src/goals/meta";

function chunk<T>(arr: ReadonlyArray<T>, size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function NewGoal() {
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  // Default due: 3 months from today.
  const [due, setDue] = useState<Date>(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 3);
    return d;
  });
  const [icon, setIcon] = useState<typeof DEFAULT_GOAL_ICON>(DEFAULT_GOAL_ICON);
  // Each new-goal session gets a random palette color so the user
  // doesn't have to pick — they can still override. `useState(() => ...)`
  // runs once on mount, not every render.
  const [color, setColor] = useState<string>(() => randomGoalColor());
  const [dateOpen, setDateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const trimmedTitle = title.trim();
    const num = Number(target);
    if (!trimmedTitle || !Number.isFinite(num) || num <= 0 || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      await apiFetch<{ goal: GoalDTO }>(`/workspaces/${wsId}/goals`, {
        method: "POST",
        body: JSON.stringify({
          title: trimmedTitle,
          targetAmount: num,
          dueDate: ymd(due),
          icon,
          color,
        }),
      });
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "save_failed";
      setErr(`Couldn't save: ${code}`);
      setSubmitting(false);
    }
  }, [title, target, due, icon, color, submitting]);

  const canSubmit =
    !submitting &&
    title.trim().length > 0 &&
    Number.isFinite(Number(target)) &&
    Number(target) > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={styles.head}>
        <Pressable onPress={() => router.back()} disabled={submitting} hitSlop={8}>
          <Text style={styles.cancel}>Cancel</Text>
        </Pressable>
        <Text style={styles.title}>New goal</Text>
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
          {/* Preview */}
          <View style={styles.previewRow}>
            <View
              style={[
                styles.previewGlyph,
                { backgroundColor: withAlpha(color, 0.14) },
              ]}
            >
              <Ionicons name={icon} size={22} color={color} />
            </View>
            <Text
              style={[
                styles.previewName,
                !title.trim() && { color: colors.mutedSoft },
              ]}
              numberOfLines={1}
            >
              {title.trim() || "Goal title"}
            </Text>
          </View>

          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={(v) => {
              setTitle(v);
              if (err) setErr(null);
            }}
            placeholder="e.g. Japan trip"
            placeholderTextColor={colors.mutedSoft}
            autoFocus
            editable={!submitting}
            maxLength={80}
            returnKeyType="next"
          />

          <Text style={styles.label}>Target amount</Text>
          <View style={styles.amountRow}>
            <Text style={styles.amountCurrency}>$</Text>
            <TextInput
              style={styles.amountInput}
              value={target}
              onChangeText={(v) => {
                if (/^\d*\.?\d{0,2}$/.test(v)) setTarget(v);
              }}
              placeholder="0"
              placeholderTextColor={colors.mutedSoft}
              keyboardType="decimal-pad"
              editable={!submitting}
            />
          </View>

          <Text style={styles.label}>By</Text>
          <Pressable
            style={styles.dueBtn}
            onPress={() => {
              Keyboard.dismiss();
              setDateOpen(true);
            }}
            disabled={submitting}
          >
            <Ionicons name="calendar-outline" size={18} color={colors.muted} />
            <Text style={styles.dueText}>
              {due.toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={colors.mutedSoft} />
          </Pressable>

          <Text style={styles.label}>Color</Text>
          {chunk(GOAL_COLOR_CHOICES, 7).map((row, ri) => (
            <View key={ri} style={styles.gridRow}>
              {row.map((c) => {
                const isSel = c === color;
                return (
                  <Pressable
                    key={c}
                    onPress={() => setColor(c)}
                    style={[
                      styles.colorChip,
                      { backgroundColor: c },
                      isSel && styles.colorChipActive,
                    ]}
                  >
                    {isSel && (
                      <Ionicons name="checkmark" size={16} color="#fff" />
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))}

          <Text style={[styles.label, { marginTop: space.base }]}>Icon</Text>
          {chunk(GOAL_ICON_CHOICES, 4).map((row, ri) => (
            <View key={ri} style={styles.gridRow}>
              {row.map((i) => {
                const isSel = i === icon;
                return (
                  <Pressable
                    key={i}
                    onPress={() => setIcon(i)}
                    style={[
                      styles.iconChip,
                      isSel && { borderColor: color },
                    ]}
                  >
                    <Ionicons
                      name={i}
                      size={20}
                      color={isSel ? color : colors.muted}
                    />
                  </Pressable>
                );
              })}
            </View>
          ))}

          {err && <Text style={styles.error}>{err}</Text>}
        </ScrollView>
      </KeyboardAvoidingView>

      <DatePickerSheet
        visible={dateOpen}
        value={due}
        mode="date"
        maximumDate={new Date(Date.now() + 10 * 365 * 86400_000)}
        onClose={() => setDateOpen(false)}
        onConfirm={(next) => {
          setDue(next);
          setDateOpen(false);
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
  },
  previewName: { ...type$.titleMd, color: colors.ink, flex: 1, flexShrink: 1 },
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
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 12,
    marginBottom: space.lg,
    gap: 4,
  },
  // Match line-height + zero padding on both sides so the `$` glyph
  // and the TextInput cursor sit on the same baseline. iOS TextInput
  // adds invisible vertical padding by default; explicit lineHeight on
  // BOTH children is the predictable fix.
  amountCurrency: { ...type$.bodyMd, color: colors.ink, lineHeight: 20 },
  amountInput: {
    flex: 1,
    ...type$.bodyMd,
    color: colors.ink,
    lineHeight: 20,
    paddingVertical: 0,
    includeFontPadding: false,
  },
  dueBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 14,
    marginBottom: space.lg,
  },
  dueText: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", flex: 1 },
  gridRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  iconChip: {
    width: 70,
    height: 56,
    borderRadius: 14,
    backgroundColor: colors.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorChip: {
    width: 38,
    height: 38,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorChipActive: { borderColor: colors.ink },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.sm },
});
