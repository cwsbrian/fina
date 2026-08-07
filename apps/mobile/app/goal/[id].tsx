import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
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
import { useWorkspaceCurrency } from "../../src/workspace/useWorkspaceCurrency";
import {
  formatDue,
  goalAccent,
  goalIcon,
  goalStatus,
  withAlpha,
} from "../../src/goals/meta";
import { categoryMeta } from "../../src/categories/meta";
import type { CategoryDTO } from "@fina/shared";

export default function GoalDetail() {
  const currency = useWorkspaceCurrency();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [goal, setGoal] = useState<GoalDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
  const pct = target > 0 ? Math.min(100, Math.round((saved / target) * 100)) : 0;
  const accent = goalAccent(goal);
  const icon = goalIcon(goal);
  const due = new Date(goal.dueDate);
  const status = goalStatus({
    saved,
    target,
    due,
    now: new Date(),
    createdAt: new Date(goal.createdAt),
  });

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
                {formatMoney(goal.savedAmount, currency).display}
              </Text>
              <Text style={styles.heroSavedOf}>
                {" "}/ {formatMoney(goal.targetAmount, currency).display}
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
              <Text
                style={[
                  styles.axisText,
                  { color: statusFg(status), fontWeight: "600" },
                ]}
              >
                {pct}%
              </Text>
              <View style={styles.axisDot} />
              <Text
                style={[styles.axisText, { color: statusFg(status) }]}
                numberOfLines={1}
              >
                {status === "on-track"
                  ? "On track"
                  : status === "behind"
                    ? "Behind"
                    : status === "done"
                      ? "Done"
                      : "Paused"}
              </Text>
              <View style={styles.axisDot} />
              <Text
                style={styles.axisText}
                numberOfLines={1}
              >
                {formatDue(due, new Date())}
              </Text>
            </View>
          </View>
        </View>

        {/* AI strategy / Path */}
        <PathSection
          goal={goal}
          accent={accent}
          currency={currency}
          onRegenerated={(g) => setGoal(g)}
        />

        <Text style={styles.groupLabel}>Progress</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Saved so far</Text>
            <Text style={styles.rowValue}>
              {formatMoney(goal.savedAmount, currency).display}
            </Text>
          </View>
          <Text style={styles.rowCaption}>
            Auto-tallied from staying under budget on the categories in
            your plan above.
          </Text>
        </View>

        <Text style={styles.groupLabel}>Details</Text>
        <View style={styles.group}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Target</Text>
            <Text style={styles.rowValue}>{formatMoney(goal.targetAmount, currency).display}</Text>
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

function PathSection({
  goal,
  accent,
  currency,
  onRegenerated,
}: {
  goal: GoalDTO;
  accent: string;
  currency: string;
  onRegenerated: (g: GoalDTO) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [autoTried, setAutoTried] = useState(false);
  const strategy = goal.strategy;

  const regenerate = useCallback(
    async (silent = false) => {
      if (busy) return;
      setBusy(true);
      setFailed(false);
      try {
        const wsId = await getActiveWorkspaceId();
        if (!wsId) throw new Error("no_workspace");
        const r = await apiFetch<{ goal: GoalDTO }>(
          `/workspaces/${wsId}/goals/${goal.id}/strategy`,
          { method: "POST" },
        );
        onRegenerated(r.goal);
      } catch (e) {
        setFailed(true);
        if (!silent) {
          Alert.alert(
            "Couldn't build a plan",
            (e as { code?: string }).code ?? "Try again.",
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, goal.id, onRegenerated],
  );

  const allocations = goal.allocations;
  const noPlanYet = !strategy && allocations.length === 0;

  // Goal has no plan yet (never generated, or a prior attempt failed
  // leaving strategy null). Kick generation once automatically so an
  // existing goal self-heals on open; the server route generates
  // synchronously and returns the updated goal.
  useEffect(() => {
    if (noPlanYet && !autoTried && !busy) {
      setAutoTried(true);
      void regenerate(true);
    }
  }, [noPlanYet, autoTried, busy, regenerate]);

  // No plan yet. While a request is in flight show the "putting it
  // together" spinner; otherwise (idle/failed) offer a button so the
  // user is never stuck on an endless spinner.
  if (noPlanYet) {
    return (
      <>
        <Text style={styles.groupLabel}>Path</Text>
        <View style={[styles.group, styles.pathHint]}>
          <View style={[styles.pathHintGlyph, { backgroundColor: withAlpha(accent, 0.12) }]}>
            {busy ? (
              <ActivityIndicator color={accent} />
            ) : (
              <Ionicons name="sparkles-outline" size={20} color={accent} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.pathHintTitle}>
              {busy
                ? "Fina is putting a plan together"
                : failed
                  ? "Couldn't build a plan"
                  : "No plan yet"}
            </Text>
            <Text style={styles.pathHintBody}>
              {busy
                ? "I'll suggest where to trim and reroute spending based on your recent activity."
                : "Fina builds a savings plan from your recent activity. Tap to generate it."}
            </Text>
            {!busy ? (
              <Pressable
                onPress={() => regenerate(false)}
                hitSlop={8}
                style={({ pressed }) => [styles.pathHintBtn, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.regenText}>
                  {failed ? "Try again" : "Generate plan"}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </>
    );
  }

  const totalMo = allocations.reduce(
    (sum, a) => sum + (Number(a.monthlyAmount) || 0),
    0,
  );

  return (
    <>
      <View style={styles.pathHead}>
        <Text style={styles.pathHeadLabel}>
          {allocations.length > 0
            ? `Path · ${formatMoney(totalMo.toFixed(2), currency).display}/mo`
            : "Path"}
        </Text>
        <Pressable
          onPress={() => regenerate(false)}
          disabled={busy}
          hitSlop={8}
          style={({ pressed }) => [pressed && { opacity: 0.6 }]}
        >
          {busy ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.regenText}>Regenerate</Text>
          )}
        </Pressable>
      </View>

      {allocations.length === 0 ? (
        <View style={[styles.group, styles.pathHint]}>
          <View style={[styles.pathHintGlyph, { backgroundColor: colors.surfaceSoft }]}>
            <Ionicons name="information-circle-outline" size={20} color={colors.muted} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.pathHintTitle}>No plan yet</Text>
            <Text style={styles.pathHintBody}>
              {strategy?.notice ??
                "Add a few transactions and tap Regenerate so Fina has something to work with."}
            </Text>
          </View>
        </View>
      ) : (
        <View style={styles.group}>
          {allocations.map((item, idx) => {
            // Build the minimum shape categoryMeta needs from the
            // joined category fields on the allocation.
            const catShape = {
              id: item.categoryId,
              name: item.categoryName,
              icon: item.categoryIcon,
              color: item.categoryColor,
            } as unknown as CategoryDTO;
            const meta = categoryMeta(catShape);
            return (
              <View
                key={item.categoryId}
                style={[
                  styles.pathRow,
                  idx === allocations.length - 1 && { borderBottomWidth: 0 },
                ]}
              >
                <View style={[styles.pathRowGlyph, { backgroundColor: meta.bg }]}>
                  <Ionicons name={meta.icon} size={14} color={meta.fg} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.pathRowTitle}>{item.categoryName}</Text>
                  {item.rationale && (
                    <Text style={styles.pathRowMeta}>{item.rationale}</Text>
                  )}
                </View>
                <Text style={styles.pathRowAmt}>
                  +{formatMoney(Number(item.monthlyAmount).toFixed(2), currency).display}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </>
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
    // Explicit lineHeight so the top of the glyphs isn't clipped on
    // Android (large Text with no lineHeight gets a too-short line box).
    lineHeight: 44,
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
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  axisText: { ...type$.bodySm, color: colors.muted, flexShrink: 1 },
  axisDot: {
    width: 3,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.mutedSoft,
  },

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
  rowCaption: {
    ...type$.bodySm,
    color: colors.muted,
    paddingHorizontal: space.base,
    paddingBottom: 12,
    marginTop: -6,
  },

  // Path / strategy
  pathHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  pathHeadLabel: {
    ...type$.bodySm,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "600",
  },
  regenText: { ...type$.bodySm, color: colors.primary, fontWeight: "600" },
  pathHint: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    padding: space.base,
  },
  pathHintGlyph: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  pathHintTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  pathHintBody: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  pathHintBtn: { marginTop: space.sm, alignSelf: "flex-start" },
  pathRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm + 2,
    padding: space.base,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  pathRowGlyph: {
    width: 28,
    height: 28,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  pathRowTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  pathRowMeta: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  pathRowAmt: { ...type$.bodyMd, color: colors.up, fontWeight: "600" },
});
