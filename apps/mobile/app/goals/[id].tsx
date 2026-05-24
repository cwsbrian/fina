import { useCallback, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { GoalDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { formatMoney } from "../../src/format/money";
import {
  formatDue,
  goalAccent,
  goalIcon,
  goalStatus,
  withAlpha,
} from "../../src/goals/meta";

export default function GoalDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [goal, setGoal] = useState<GoalDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editingSaved, setEditingSaved] = useState(false);
  const [savedDraft, setSavedDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const data = await apiFetch<{ goal: GoalDTO }>(
        `/workspaces/${wsId}/goals/${id}`,
      );
      setGoal(data.goal);
      setSavedDraft(Number(data.goal.savedAmount).toFixed(2));
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const saveSaved = async () => {
    if (!goal) return;
    const n = Number(savedDraft);
    if (!Number.isFinite(n) || n < 0) return;
    setBusy(true);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      const r = await apiFetch<{ goal: GoalDTO }>(
        `/workspaces/${wsId}/goals/${goal.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ savedAmount: n }),
        },
      );
      setGoal(r.goal);
      setEditingSaved(false);
    } catch (e) {
      Alert.alert("Couldn't save", (e as { code?: string }).code ?? "Try again.");
    } finally {
      setBusy(false);
    }
  };

  const onDelete = () => {
    if (!goal) return;
    Alert.alert(
      "Delete goal?",
      `"${goal.title}" will be removed permanently.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const wsId = await getActiveWorkspaceId();
              if (!wsId) throw new Error("no_workspace");
              await apiFetch(`/workspaces/${wsId}/goals/${goal.id}`, {
                method: "DELETE",
              });
              router.back();
            } catch (e) {
              Alert.alert(
                "Couldn't delete",
                (e as { code?: string }).code ?? "Try again.",
              );
            }
          },
        },
      ],
    );
  };

  if (err) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header onBack={() => router.back()} />
        <View style={styles.fallback}>
          <Text style={styles.errTitle}>Couldn't load goal</Text>
          <Text style={styles.errBody}>{err}</Text>
          <Pressable style={styles.cta} onPress={load}>
            <Text style={styles.ctaText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!goal) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Header onBack={() => router.back()} />
        <View style={styles.fallback}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </SafeAreaView>
    );
  }

  const target = Number(goal.targetAmount);
  const saved = Number(goal.savedAmount);
  const remaining = Math.max(0, target - saved);
  const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
  const accent = goalAccent(goal);
  const icon = goalIcon(goal);
  const due = new Date(goal.dueDate);
  const status = goalStatus({ saved, target, due, now: new Date() });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header onBack={() => router.back()} onDelete={onDelete} />

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <View style={styles.heroTop}>
            <View
              style={[styles.heroGlyph, { backgroundColor: withAlpha(accent, 0.14) }]}
            >
              <Ionicons name={icon} size={22} color={accent} />
            </View>
            <Text style={styles.heroTitle} numberOfLines={2}>
              {goal.title}
            </Text>
          </View>
          {goal.description ? (
            <Text style={styles.heroDesc}>{goal.description}</Text>
          ) : null}

          <View style={styles.heroProgress}>
            <Text style={styles.heroSaved}>
              <Text style={styles.heroSavedNum}>
                {formatMoney(goal.savedAmount).display}
              </Text>
              <Text style={styles.heroSavedOf}>
                {" "}/ {formatMoney(goal.targetAmount).display}
              </Text>
            </Text>
            <View style={styles.bar}>
              <View
                style={[
                  styles.barFill,
                  { width: `${pct}%`, backgroundColor: accent },
                ]}
              />
            </View>
            <View style={styles.heroAxis}>
              <Text style={styles.axisText}>{pct}%</Text>
              <Text style={[styles.axisText, { color: statusFg(status) }]}>
                {status === "on-track"
                  ? `On track · ${formatDue(due, new Date())}`
                  : status === "behind"
                    ? `Behind · ${formatDue(due, new Date())}`
                    : status === "done"
                      ? "Done"
                      : "Paused"}
              </Text>
              <Text style={styles.axisText}>
                {formatMoney(remaining.toFixed(2)).display} to go
              </Text>
            </View>
          </View>
        </View>

        <Text style={styles.groupLabel}>Progress</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Saved so far</Text>
            {editingSaved ? (
              <View style={styles.savedInputWrap}>
                <Text style={styles.savedInputCurrency}>$</Text>
                <TextInput
                  style={styles.savedInput}
                  value={savedDraft}
                  onChangeText={(v) => {
                    if (/^\d*\.?\d{0,2}$/.test(v)) setSavedDraft(v);
                  }}
                  keyboardType="decimal-pad"
                  editable={!busy}
                  autoFocus
                  onBlur={saveSaved}
                  returnKeyType="done"
                  onSubmitEditing={saveSaved}
                />
              </View>
            ) : (
              <Pressable
                onPress={() => setEditingSaved(true)}
                style={({ pressed }) => [
                  styles.rowValueBtn,
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Text style={styles.rowValue}>
                  {formatMoney(goal.savedAmount).display}
                </Text>
                <Ionicons name="chevron-forward" size={16} color={colors.mutedSoft} />
              </Pressable>
            )}
          </View>
        </View>

        <Text style={styles.groupLabel}>Details</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Target</Text>
            <Text style={styles.rowValue}>{formatMoney(goal.targetAmount).display}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Due date</Text>
            <Text style={styles.rowValue}>
              {due.toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function statusFg(s: ReturnType<typeof goalStatus>): string {
  if (s === "on-track") return colors.up;
  if (s === "behind") return "#b54550";
  if (s === "done") return colors.primary;
  return colors.muted;
}

function Header({
  onBack,
  onDelete,
}: {
  onBack: () => void;
  onDelete?: () => void;
}) {
  return (
    <View style={styles.nav}>
      <HeaderIconButton
        icon="chevron-back"
        accessibilityLabel="Back"
        onPress={onBack}
        variant="plain"
      />
      <Text style={styles.navTitle}>Goal</Text>
      {onDelete ? (
        <HeaderIconButton
          icon="trash-outline"
          accessibilityLabel="Delete"
          onPress={onDelete}
          color={colors.down}
          variant="plain"
        />
      ) : (
        <View style={{ width: 34 }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: space.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  navTitle: { ...type$.titleSm, color: colors.ink },
  scroll: { paddingBottom: space.xl },
  fallback: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.xl,
    paddingVertical: 14,
    borderRadius: 999,
  },
  ctaText: { ...type$.button, color: colors.onPrimary },

  hero: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl },
  heroTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    marginBottom: space.sm,
  },
  heroGlyph: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  heroTitle: { ...type$.titleMd, color: colors.ink, flex: 1 },
  heroDesc: { ...type$.bodyMd, color: colors.body, marginBottom: space.base },
  heroProgress: { marginTop: space.sm },
  heroSaved: { marginBottom: 14 },
  heroSavedNum: {
    fontSize: 36,
    fontWeight: "500",
    letterSpacing: -1.2,
    color: colors.ink,
  },
  heroSavedOf: { ...type$.bodyMd, color: colors.muted },
  bar: {
    height: 10,
    borderRadius: 999,
    backgroundColor: colors.surfaceSoft,
    overflow: "hidden",
  },
  barFill: { height: "100%", borderRadius: 999 },
  heroAxis: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  axisText: { ...type$.bodySm, color: colors.muted },

  groupLabel: {
    ...type$.bodySm,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
    fontWeight: "600",
  },
  group: {
    marginHorizontal: space.base,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 16,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.base,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  rowLabel: { ...type$.bodyMd, color: colors.ink },
  rowValue: { ...type$.bodyMd, color: colors.muted },
  rowValueBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  savedInputWrap: { flexDirection: "row", alignItems: "center", gap: 2 },
  savedInputCurrency: { ...type$.bodyMd, color: colors.ink },
  savedInput: {
    ...type$.bodyMd,
    color: colors.ink,
    minWidth: 80,
    textAlign: "right",
    paddingVertical: 0,
  },
});
