import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { CategoryDTO, MeDTO as Me } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { categoryMeta } from "../../src/categories/meta";

type Allocation = { categoryId: string; amount: string };

type SuggestionResp = {
  allocations: Array<{ categoryId: string; categoryName: string; amount: number }>;
  notice?: string;
};

type Plan = {
  id: string;
  periodStart: string;
  totalAmount: string;
  categoryAllocations: Array<{ categoryId: string; amount: number }>;
};

type Scope = "month" | "default";

function currentYearMonth(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

type CurrentResp = {
  yearMonth: string;
  plan: Plan | null;
};

export default function NewBudget() {
  const [me, setMe] = useState<Me | null>(null);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [defaultPlan, setDefaultPlan] = useState<Plan | null>(null);
  const [monthPlan, setMonthPlan] = useState<Plan | null>(null);
  const [scope, setScope] = useState<Scope>("month");
  const [total, setTotal] = useState("");
  const [allocs, setAllocs] = useState<Allocation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [suggestNotice, setSuggestNotice] = useState<string | null>(null);

  // Hydrate the form whenever the scope flips so the user always sees
  // the values for the scope they're editing.
  useEffect(() => {
    const plan = scope === "month" ? monthPlan : defaultPlan;
    if (plan) {
      setTotal(Number(plan.totalAmount).toFixed(2));
      setAllocs(
        plan.categoryAllocations.map((a) => ({
          categoryId: a.categoryId,
          amount: a.amount.toFixed(2),
        })),
      );
    } else {
      setTotal("");
      setAllocs([]);
    }
  }, [scope, defaultPlan, monthPlan]);

  useEffect(() => {
    apiFetch<Me>("/me").then(setMe).catch(() => {});
    (async () => {
      try {
        const wsId =
          (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
        if (!wsId) return;
        const [catResp, defResp, curResp] = await Promise.all([
          apiFetch<{ categories: CategoryDTO[] }>(
            `/workspaces/${wsId}/categories`,
          ),
          apiFetch<{ plan: Plan | null }>(
            `/workspaces/${wsId}/budget-plans/default`,
          ),
          apiFetch<CurrentResp>(`/workspaces/${wsId}/budget-plans/current`),
        ]);
        setCategories(catResp.categories.filter((c) => !c.archivedAt));
        setDefaultPlan(defResp.plan);
        setMonthPlan(curResp.plan);
      } catch {
        // load failures non-fatal
      }
    })();
  }, []);

  const isPro = (me?.tier === "pro" || me?.trial.active) ?? false;

  const onSuggest = useCallback(async () => {
    const totalNum = Number(total);
    if (!Number.isFinite(totalNum) || totalNum <= 0 || suggesting) return;
    setSuggesting(true);
    setSuggestNotice(null);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      const r = await apiFetch<SuggestionResp>(
        `/workspaces/${wsId}/budget-plans/suggest-split`,
        {
          method: "POST",
          body: JSON.stringify({ totalAmount: totalNum }),
        },
      );
      if (r.allocations.length > 0) {
        setAllocs(
          r.allocations.map((a) => ({
            categoryId: a.categoryId,
            amount: a.amount.toFixed(2),
          })),
        );
      } else if (r.notice) {
        setSuggestNotice(r.notice);
      }
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      Alert.alert(
        "Couldn't suggest a split",
        code === "upgrade_required"
          ? "Pro tier is required for auto-split."
          : `Try again (${code}).`,
      );
    } finally {
      setSuggesting(false);
    }
  }, [total, suggesting]);

  const submit = useCallback(async () => {
    const totalNum = Number(total);
    if (!Number.isFinite(totalNum) || totalNum <= 0 || submitting) return;
    setSubmitting(true);
    setErr(null);
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      const sanitized = allocs
        .map((a) => ({
          categoryId: a.categoryId,
          amount: Math.max(0, Number(a.amount) || 0),
        }))
        .filter((a) => a.amount > 0);
      const body = {
        totalAmount: totalNum,
        categoryAllocations: sanitized,
      };
      // Scope toggle picks the route: month writes a snapshot, default
      // overwrites the template. First-time setup (no default yet)
      // forces default scope so the next month already inherits.
      if (scope === "month" && defaultPlan) {
        await apiFetch<{ plan: Plan }>(
          `/workspaces/${wsId}/budget-plans/months/${currentYearMonth()}`,
          { method: "POST", body: JSON.stringify(body) },
        );
      } else {
        await apiFetch<{ plan: Plan }>(
          `/workspaces/${wsId}/budget-plans/default`,
          {
            method: "POST",
            body: JSON.stringify({
              ...body,
              // First setup: apply to current month too so the user
              // sees their work immediately.
              scope: defaultPlan ? "default_only" : "default_and_current",
            }),
          },
        );
      }
      router.back();
    } catch (e) {
      const code = (e as { code?: string }).code ?? "save_failed";
      setErr(`Couldn't save: ${code}`);
      setSubmitting(false);
    }
  }, [scope, total, allocs, defaultPlan, submitting]);

  const setAlloc = (categoryId: string, amount: string) => {
    if (!/^\d*\.?\d{0,2}$/.test(amount)) return;
    setAllocs((prev) => {
      const idx = prev.findIndex((a) => a.categoryId === categoryId);
      if (idx === -1) return [...prev, { categoryId, amount }];
      const next = prev.slice();
      next[idx] = { categoryId, amount };
      return next;
    });
  };

  const totalNum = Number(total);
  const allocSum = allocs.reduce(
    (s, a) => s + (Number(a.amount) || 0),
    0,
  );
  const canSubmit =
    !submitting && Number.isFinite(totalNum) && totalNum > 0;

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
        <Text style={styles.title}>
          {defaultPlan ? "Edit budget" : "New budget"}
        </Text>
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
          {/* Scope toggle — only show once a default exists. First-time
              setup is implicitly "default + current month". */}
          {defaultPlan && (
            <>
              <View style={styles.seg}>
                <Pressable
                  style={[styles.segOpt, scope === "month" && styles.segActive]}
                  onPress={() => setScope("month")}
                  disabled={submitting}
                >
                  <Text
                    style={[
                      styles.segText,
                      scope === "month" && styles.segTextActive,
                    ]}
                  >
                    This month
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.segOpt, scope === "default" && styles.segActive]}
                  onPress={() => setScope("default")}
                  disabled={submitting}
                >
                  <Text
                    style={[
                      styles.segText,
                      scope === "default" && styles.segTextActive,
                    ]}
                  >
                    Default
                  </Text>
                </Pressable>
              </View>
              <Text style={styles.scopeHelp}>
                {scope === "month"
                  ? "Edits apply to the current month only — your default stays as-is for next month."
                  : "Edits update the default that every new month is copied from. The current month isn't affected unless you flip it above."}
              </Text>
            </>
          )}

          <Text style={styles.label}>Monthly total</Text>
          <View style={styles.amountRow}>
            <Text style={styles.amountCurrency}>$</Text>
            <TextInput
              style={styles.amountInput}
              value={total}
              onChangeText={(v) => {
                if (/^\d*\.?\d{0,2}$/.test(v)) setTotal(v);
              }}
              placeholder="0"
              placeholderTextColor={colors.mutedSoft}
              keyboardType="decimal-pad"
              editable={!submitting}
              autoFocus
            />
          </View>

          {/* Pro-only auto-split */}
          {isPro && totalNum > 0 && (
            <Pressable
              onPress={onSuggest}
              disabled={suggesting}
              style={({ pressed }) => [
                styles.suggestBtn,
                (pressed || suggesting) && { opacity: 0.6 },
              ]}
            >
              {suggesting ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <>
                  <Ionicons
                    name="sparkles-outline"
                    size={14}
                    color={colors.primary}
                  />
                  <Text style={styles.suggestText}>
                    {allocs.length > 0
                      ? "Re-suggest split"
                      : "Let Fina split this for you"}
                  </Text>
                </>
              )}
            </Pressable>
          )}
          {suggestNotice && (
            <Text style={styles.notice}>{suggestNotice}</Text>
          )}

          {/* Category breakdown */}
          <View style={styles.catLabelRow}>
            <Text style={styles.label}>By category (optional)</Text>
            {totalNum > 0 && allocSum > 0 && (
              <Text
                style={[
                  styles.allocSum,
                  allocSum > totalNum && { color: colors.down },
                ]}
              >
                ${allocSum.toFixed(2)} / ${totalNum.toFixed(2)}
              </Text>
            )}
          </View>

          {categories.map((c) => {
            const meta = categoryMeta(c);
            const a = allocs.find((x) => x.categoryId === c.id);
            return (
              <View key={c.id} style={styles.catRow}>
                <View style={[styles.catGlyph, { backgroundColor: meta.bg }]}>
                  <Ionicons name={meta.icon} size={16} color={meta.fg} />
                </View>
                <Text style={styles.catName} numberOfLines={1}>
                  {c.name}
                </Text>
                <View style={styles.catInputWrap}>
                  <Text style={styles.catInputCurrency}>$</Text>
                  <TextInput
                    style={styles.catInput}
                    value={a?.amount ?? ""}
                    onChangeText={(v) => setAlloc(c.id, v)}
                    placeholder="0"
                    placeholderTextColor={colors.mutedSoft}
                    keyboardType="decimal-pad"
                    editable={!submitting}
                  />
                </View>
              </View>
            );
          })}

          {err && <Text style={styles.error}>{err}</Text>}

          <Text style={styles.helper}>
            Categories are optional — set caps on the ones you want to track,
            leave the rest blank. Fina shows progress against whatever is set.
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
    marginBottom: 8,
  },
  segOpt: {
    flex: 1,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
  },
  segActive: { backgroundColor: colors.canvas },
  segText: { ...type$.bodyMd, color: colors.muted, fontWeight: "600" },
  segTextActive: { color: colors.ink },
  scopeHelp: {
    ...type$.bodySm,
    color: colors.muted,
    marginBottom: space.lg,
    paddingHorizontal: 4,
  },
  label: {
    ...type$.bodySm,
    color: colors.muted,
    fontWeight: "600",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: space.xs,
  },
  amountRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surfaceSoft,
    borderRadius: 12,
    paddingHorizontal: space.base,
    paddingVertical: 14,
    marginBottom: space.lg,
    gap: 4,
  },
  amountCurrency: { fontSize: 22, fontWeight: "500", color: colors.ink },
  amountInput: {
    flex: 1,
    fontSize: 32,
    fontWeight: "500",
    color: colors.ink,
    paddingVertical: 0,
  },
  suggestBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
    marginBottom: space.base,
  },
  suggestText: { ...type$.bodyMd, color: colors.primary, fontWeight: "600" },
  notice: { ...type$.bodySm, color: colors.muted, marginBottom: space.base },
  catLabelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginTop: space.sm,
  },
  allocSum: { ...type$.bodySm, color: colors.muted, marginBottom: space.xs },
  catRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  catGlyph: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  catName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600", flex: 1 },
  catInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minWidth: 100,
    justifyContent: "flex-end",
  },
  catInputCurrency: { ...type$.bodyMd, color: colors.ink },
  catInput: {
    ...type$.bodyMd,
    color: colors.ink,
    minWidth: 60,
    textAlign: "right",
    paddingVertical: 0,
  },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.sm },
  helper: {
    ...type$.bodySm,
    color: colors.muted,
    marginTop: space.lg,
    textAlign: "center",
  },
});
