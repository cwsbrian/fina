import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router, useFocusEffect } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
  type BottomSheetFlatListMethods,
} from "@gorhom/bottom-sheet";
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

type CurrentResp = {
  yearMonth: string;
  plan: Plan | null;
};

type PlaidItemsResp = {
  plaidItems: Array<{ id: string }>;
};

export default function NewBudget() {
  const categorySheetRef = useRef<BottomSheet>(null);
  const categoryListRef = useRef<BottomSheetFlatListMethods>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [defaultPlan, setDefaultPlan] = useState<Plan | null>(null);
  const [monthPlan, setMonthPlan] = useState<Plan | null>(null);
  const [currentYearMonth, setCurrentYearMonth] = useState<string | null>(null);
  const [recentAvg, setRecentAvg] = useState<number | null>(null);
  const [bankCount, setBankCount] = useState<number | null>(null);
  const [scope, setScope] = useState<Scope>("month");
  const [total, setTotal] = useState("");
  const [allocs, setAllocs] = useState<Allocation[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [categorySheetOpen, setCategorySheetOpen] = useState(false);
  const categorySnapPoints = useMemo(() => ["88%"], []);
  const scrollCategoryInputIntoView = useCallback((index: number) => {
    requestAnimationFrame(() => {
      categoryListRef.current?.scrollToIndex({
        index,
        animated: true,
        viewPosition: 0.35,
      });
    });
  }, []);
  const handleCategoryScrollToIndexFailed = useCallback(
    (info: { averageItemLength: number; index: number }) => {
      requestAnimationFrame(() => {
        categoryListRef.current?.scrollToOffset({
          offset: Math.max(0, info.averageItemLength * info.index),
          animated: true,
        });
      });
    },
    [],
  );

  const loadCategories = useCallback(async (workspaceId: string) => {
    const data = await apiFetch<{ categories: CategoryDTO[] }>(
      `/workspaces/${workspaceId}/categories?type=expense`,
    );
    setCategories(data.categories.filter((c) => !c.archivedAt));
  }, []);

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
        const [defResp, curResp, plaidResp] = await Promise.all([
          apiFetch<{ plan: Plan | null; recentMonthlyAvgSpend?: number }>(
            `/workspaces/${wsId}/budget-plans/default`,
          ),
          apiFetch<CurrentResp>(`/workspaces/${wsId}/budget-plans/current`),
          apiFetch<PlaidItemsResp>(`/workspaces/${wsId}/plaid-items`),
        ]);
        await loadCategories(wsId);
        setDefaultPlan(defResp.plan);
        setMonthPlan(curResp.plan);
        setCurrentYearMonth(curResp.yearMonth);
        setBankCount(plaidResp.plaidItems.length);
        if (typeof defResp.recentMonthlyAvgSpend === "number") {
          setRecentAvg(defResp.recentMonthlyAvgSpend);
        }
      } catch {
        // load failures non-fatal
      }
    })();
  }, [loadCategories]);

  useFocusEffect(
    useCallback(() => {
      if (!categorySheetOpen) return;
      (async () => {
        const wsId =
          (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
        if (wsId) await loadCategories(wsId);
      })().catch(() => {});
    }, [categorySheetOpen, loadCategories]),
  );

  const isPro = (me?.tier === "pro" || me?.tier === "max" || me?.trial.active) ?? false;

  const suggestSplit = useCallback(async (
    totalAmount: number,
    opts?: { fillTotal?: boolean },
  ) => {
    try {
      const wsId = await getActiveWorkspaceId();
      if (!wsId) throw new Error("no_workspace");
      const r = await apiFetch<SuggestionResp>(
        `/workspaces/${wsId}/budget-plans/suggest-split`,
        {
          method: "POST",
          body: JSON.stringify({ totalAmount }),
        },
      );
      if (r.allocations.length > 0) {
        if (opts?.fillTotal) setTotal(totalAmount.toFixed(2));
        setAllocs(
          r.allocations.map((a) => ({
            categoryId: a.categoryId,
            amount: a.amount.toFixed(2),
          })),
        );
        Keyboard.dismiss();
        setCategorySheetOpen(true);
      } else if (r.notice) {
        Alert.alert(
          "Three months of history needed",
          `${r.notice} You can still save a total-only budget for now.`,
          bankCount === 0
            ? [
                { text: "OK", style: "cancel" },
                {
                  text: "Connect bank",
                  style: "default",
                  isPreferred: true,
                  onPress: () => router.push("/banks" as never),
                },
              ]
            : [{ text: "OK", style: "cancel" }],
        );
      }
    } catch (e) {
      const code = (e as { code?: string }).code ?? "error";
      Alert.alert(
        "Couldn't suggest a split",
        code === "upgrade_required"
          ? "Pro tier is required for auto-split."
          : `Try again (${code}).`,
      );
    }
  }, [bankCount]);

  const onSuggest = useCallback(async () => {
    const totalNum = Number(total);
    if (!Number.isFinite(totalNum) || totalNum <= 0 || suggesting) return;
    setSuggesting(true);
    try {
      await suggestSplit(totalNum);
    } finally {
      setSuggesting(false);
    }
  }, [total, suggesting, suggestSplit]);

  const onDecide = useCallback(async () => {
    if (deciding) return;
    if (!isPro) {
      Alert.alert("Upgrade required", "Pro tier is required for Fina to decide a budget.");
      return;
    }
    if (recentAvg === null || recentAvg <= 0) {
      Alert.alert(
        "Three months of history needed",
        "Fina needs about three months of spending history before it can decide a budget.",
        bankCount === 0
          ? [
              { text: "OK", style: "cancel" },
              {
                text: "Connect bank",
                style: "default",
                isPreferred: true,
                onPress: () => router.push("/banks" as never),
              },
            ]
          : [{ text: "OK", style: "cancel" }],
      );
      return;
    }
    setDeciding(true);
    const nextTotal = Math.round(recentAvg);
    try {
      await suggestSplit(nextTotal, { fillTotal: true });
    } finally {
      setDeciding(false);
    }
  }, [deciding, isPro, recentAvg, bankCount, suggestSplit]);

  const doSave = useCallback(
    async (target: "month_only" | "default_only" | "both") => {
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
        if (target === "month_only") {
          if (!currentYearMonth) throw new Error("budget_month_unavailable");
          await apiFetch<{ plan: Plan }>(
            `/workspaces/${wsId}/budget-plans/months/${currentYearMonth}`,
            { method: "POST", body: JSON.stringify(body) },
          );
        } else {
          // Both default + current month, OR default only — both go
          // through the default endpoint with a scope hint.
          await apiFetch<{ plan: Plan }>(
            `/workspaces/${wsId}/budget-plans/default`,
            {
              method: "POST",
              body: JSON.stringify({
                ...body,
                scope:
                  target === "both" ? "default_and_current" : "default_only",
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
    },
    [total, allocs, submitting, currentYearMonth],
  );

  const submit = useCallback(() => {
    const totalNum = Number(total);
    if (!Number.isFinite(totalNum) || totalNum <= 0 || submitting) return;

    const proceed = () => {
      // First-time setup: no default yet → save default + apply to current
      // month implicitly. No need to ask.
      if (!defaultPlan) {
        doSave("both");
        return;
      }
      if (scope === "month") {
        Alert.alert(
          "Save this month's budget",
          "Apply these changes only to the current month, or also overwrite the default going forward?",
          [
            { text: "Cancel", style: "cancel" },
            { text: "This month only", onPress: () => doSave("month_only") },
            { text: "Apply to default too", onPress: () => doSave("both") },
          ],
        );
      } else {
        Alert.alert(
          "Save default budget",
          "Apply these changes only to the default for future months, or also overwrite the current month?",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Default only", onPress: () => doSave("default_only") },
            { text: "Apply to this month too", onPress: () => doSave("both") },
          ],
        );
      }
    };

    const afterCategoryCheck = () => {
      // Sanity-warn before save: if their chosen total is well below their
      // last-90-day average, surface it once. They can still save anyway.
      if (recentAvg != null && recentAvg > 0 && totalNum < recentAvg * 0.6) {
        Alert.alert(
          "Budget below recent spending",
          `You've averaged about $${recentAvg.toLocaleString()}/mo over the last 90 days. A $${totalNum.toLocaleString()} target will likely run over fast unless you cut spending significantly. Save anyway?`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Save anyway", onPress: proceed },
          ],
        );
        return;
      }
      proceed();
    };

    if (!allocs.some((a) => (Number(a.amount) || 0) > 0)) {
      Alert.alert(
        "Save without category budgets?",
        "Category budgets help Fina give better analysis. Are you sure you want to save only the monthly total?",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Save total-only", onPress: afterCategoryCheck },
        ],
      );
      return;
    }
    afterCategoryCheck();
  }, [scope, total, defaultPlan, doSave, submitting, recentAvg, allocs]);

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
  const allocCount = allocs.filter((a) => (Number(a.amount) || 0) > 0).length;
  const canSubmit =
    !submitting && Number.isFinite(totalNum) && totalNum > 0;
  const canSetCategories = canSubmit;
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        opacity={0.35}
        pressBehavior="close"
      />
    ),
    [],
  );
  const renderSheetListHeader = useCallback(() => {
    if (!isPro || totalNum <= 0) return null;
    return (
      <View style={styles.sheetListHeader}>
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
      </View>
    );
  }, [allocs.length, isPro, onSuggest, suggesting, totalNum]);

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
                  ? "Edits apply to the current month only. Your default stays as-is for next month."
                  : "Edits update the default that every new month is copied from. The current month isn't affected unless you flip it above."}
              </Text>
            </>
          )}

          <Pressable
            onPress={onDecide}
            disabled={submitting || deciding || suggesting}
            style={({ pressed }) => [
              styles.decideBtn,
              (pressed || deciding) && { opacity: 0.6 },
            ]}
          >
            {deciding ? (
              <ActivityIndicator size="small" color={colors.primary} />
            ) : (
              <>
                <Ionicons name="sparkles-outline" size={14} color={colors.primary} />
                <Text style={styles.suggestText}>Let Fina Decide</Text>
              </>
            )}
          </Pressable>

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

          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              setCategorySheetOpen(true);
            }}
            disabled={!canSetCategories}
            style={({ pressed }) => [
              styles.categoryButton,
              !canSetCategories && { opacity: 0.45 },
              pressed && { opacity: 0.7 },
            ]}
          >
            <View style={styles.categoryButtonCopy}>
              <Text style={styles.categoryButtonTitle}>
                Set category budgets
              </Text>
              <Text style={styles.categoryButtonSub}>
                {!canSetCategories
                  ? "Enter a monthly total first"
                  : allocCount > 0
                    ? `${allocCount} set · $${allocSum.toFixed(2)} / $${totalNum.toFixed(2)}`
                    : "Recommended for better analysis"}
              </Text>
            </View>
            <View style={styles.categoryButtonIcons}>
              {canSetCategories && allocCount === 0 && (
                <Ionicons
                  name="warning-outline"
                  size={18}
                  color={colors.accentYellow}
                />
              )}
              <Ionicons name="chevron-up" size={18} color={colors.muted} />
            </View>
          </Pressable>

          {err && <Text style={styles.error}>{err}</Text>}

          <Text style={styles.helper}>
            Category budgets unlock better analysis. If Fina doesn't have
            enough history yet, you can save total-only for now.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
      <BottomSheet
        ref={categorySheetRef}
        snapPoints={categorySnapPoints}
        enableDynamicSizing={false}
        index={categorySheetOpen ? 0 : -1}
        backdropComponent={renderBackdrop}
        onClose={() => {
          Keyboard.dismiss();
          setCategorySheetOpen(false);
        }}
        handleIndicatorStyle={styles.grabber}
        backgroundStyle={styles.sheetBackground}
        enablePanDownToClose
        keyboardBehavior="extend"
      >
        <View style={styles.sheetFixedHeader}>
          <View style={styles.sheetHead}>
            <Pressable
              onPress={() => {
                Keyboard.dismiss();
                categorySheetRef.current?.close();
              }}
              hitSlop={8}
            >
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
            <View style={styles.sheetTitleWrap}>
              <Text style={styles.title}>Category budgets</Text>
              <Text style={styles.sheetSub}>
                ${allocSum.toFixed(2)} / ${totalNum.toFixed(2)}
              </Text>
            </View>
            <Pressable
              onPress={() => {
                Keyboard.dismiss();
                if (allocSum > 0) setTotal(allocSum.toFixed(2));
                categorySheetRef.current?.close();
              }}
              hitSlop={8}
            >
              <Text style={styles.save}>Done</Text>
            </Pressable>
          </View>
        </View>
        <BottomSheetFlatList
          ref={categoryListRef}
          data={categories}
          keyExtractor={(c) => c.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.sheetList}
          ListHeaderComponent={renderSheetListHeader}
          onScrollToIndexFailed={handleCategoryScrollToIndexFailed}
          ListEmptyComponent={
            <Text style={styles.emptyCats}>No expense categories yet.</Text>
          }
          ListFooterComponent={
            <Pressable
              style={({ pressed }) => [
                styles.addCatRow,
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => {
                Keyboard.dismiss();
                router.push("/categories/new?type=expense" as never);
              }}
            >
              <View style={[styles.catGlyph, { backgroundColor: colors.surfaceSoft }]}>
                <Ionicons name="add" size={18} color={colors.ink} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.catName}>Add category</Text>
                <Text style={styles.addCatSub}>Create an expense category</Text>
              </View>
            </Pressable>
          }
          renderItem={({ item: c, index }) => {
            const meta = categoryMeta(c);
            const a = allocs.find((x) => x.categoryId === c.id);
            return (
              <View style={styles.catRow}>
                <View style={[styles.catGlyph, { backgroundColor: meta.bg }]}>
                  <Ionicons name={meta.icon} size={16} color={meta.fg} />
                </View>
                <Text style={styles.catName} numberOfLines={1}>
                  {c.name}
                </Text>
                <View style={styles.catInputWrap}>
                  <Text style={styles.catInputCurrency}>$</Text>
                  <BottomSheetTextInput
                    style={styles.catInput}
                    value={a?.amount ?? ""}
                    onChangeText={(v) => setAlloc(c.id, v)}
                    placeholder="0"
                    placeholderTextColor={colors.mutedSoft}
                    keyboardType="decimal-pad"
                    editable={!submitting}
                    onFocus={() => scrollCategoryInputIntoView(index)}
                  />
                </View>
              </View>
            );
          }}
        />
      </BottomSheet>
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
    lineHeight: 40,
    fontWeight: "500",
    color: colors.ink,
    textAlignVertical: "center",
    paddingVertical: 0,
  },
  decideBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    backgroundColor: colors.surfaceSoft,
    borderRadius: 999,
    marginBottom: space.lg,
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
  categoryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surfaceSoft,
    borderRadius: 14,
    padding: space.base,
    marginTop: space.sm,
    marginBottom: space.base,
  },
  categoryButtonCopy: { flex: 1 },
  categoryButtonTitle: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
  },
  categoryButtonSub: {
    ...type$.bodySm,
    color: colors.muted,
    marginTop: 2,
  },
  categoryButtonIcons: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs,
  },
  sheetBackground: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  grabber: { backgroundColor: colors.mutedSoft, width: 36, height: 4 },
  sheetFixedHeader: {
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    backgroundColor: colors.canvas,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  sheetList: {
    paddingHorizontal: space.lg,
    paddingBottom: 160,
  },
  sheetListHeader: {
    paddingTop: space.base,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: space.xs,
    paddingBottom: space.base,
    backgroundColor: colors.canvas,
  },
  sheetTitleWrap: {
    alignItems: "center",
    flex: 1,
  },
  sheetSub: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 2,
  },
  catRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  addCatRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
  },
  addCatSub: { ...type$.caption, color: colors.muted, marginTop: 2 },
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
    width: 88,
    textAlign: "right",
    textAlignVertical: "center",
    includeFontPadding: false,
    paddingVertical: 0,
  },
  emptyCats: { ...type$.bodyMd, color: colors.muted, textAlign: "center", padding: space.lg },
  error: { ...type$.bodySm, color: colors.down, marginTop: space.sm },
  helper: {
    ...type$.bodySm,
    color: colors.muted,
    marginTop: space.lg,
    textAlign: "center",
  },
});
