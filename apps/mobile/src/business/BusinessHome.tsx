import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useFocusEffect } from "expo-router";
import type { BusinessOverview } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../api/client";
import { formatMoney } from "../format/money";
import { colors, space, type as type$ } from "../design/tokens";
import { useCollapsingHeader } from "../design/useCollapsingHeader";

const HEADER_HEIGHT = 84;

export function BusinessHome() {
  const insets = useSafeAreaInsets();
  const header = useCollapsingHeader(HEADER_HEIGHT);
  const [overview, setOverview] = useState<BusinessOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const workspaceId = await bootstrapActiveWorkspace();
      if (!workspaceId) return;
      const yearMonth = new Date().toISOString().slice(0, 7);
      const result = await apiFetch<{ overview: BusinessOverview }>(
        `/workspaces/${workspaceId}/business/overview?yearMonth=${yearMonth}`,
      );
      setOverview(result.overview);
      setError(null);
    } catch (e) {
      setError((e as { code?: string }).code ?? "load_error");
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  const money = (amount: string) => formatMoney(amount, overview?.currency ?? "CAD").display;
  const month = overview
    ? new Date(`${overview.yearMonth}-02T00:00:00Z`).toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      })
    : "Business overview";
  return (
    <View style={styles.safe}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingTop: insets.top + HEADER_HEIGHT }]}
        onScroll={header.onScroll}
        scrollEventThrottle={header.scrollEventThrottle}
      >
        {!overview ? (
          <View style={styles.center}>
            {error ? (
              <Text style={styles.error}>{error}</Text>
            ) : (
              <ActivityIndicator color={colors.primary} />
            )}
          </View>
        ) : (
          <>
            <View style={styles.hero}>
              <Text style={styles.heroLabel}>
                {overview.hasUnreviewedTransactions
                  ? "Income minus confirmed expenses"
                  : "Income minus expenses"}
              </Text>
              <Text style={styles.heroValue}>{money(overview.incomeMinusConfirmedExpenses)}</Text>
              {overview.hasUnreviewedTransactions && (
                <Text style={styles.note}>Expense review is still outstanding.</Text>
              )}
            </View>
            <Text style={styles.eyebrow}>This month</Text>
            <View style={styles.metrics}>
              <Metric label="Income recorded" value={money(overview.incomeRecorded)} />
              <Metric
                label="Confirmed expenses"
                value={money(overview.confirmedBusinessExpenses)}
              />
              <Metric
                label="Expense review"
                value={`${overview.expenseReviewCount} · ${money(overview.expenseReviewAmount)}`}
                warning={overview.expenseReviewCount > 0}
              />
              <Metric
                label="Missing evidence"
                value={`${overview.missingEvidenceCount}`}
                warning={overview.missingEvidenceCount > 0}
                last
              />
            </View>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Recent expenses</Text>
              <Pressable onPress={() => router.push("/(tabs)/expenses" as never)}>
                <Text style={styles.link}>View all</Text>
              </Pressable>
            </View>
            <View style={styles.list}>
              {overview.recentExpenses.length ? (
                overview.recentExpenses.map((row, index) => (
                  <Pressable
                    key={row.transactionId}
                    style={[
                      styles.row,
                      index < overview.recentExpenses.length - 1 && styles.rowBorder,
                    ]}
                    onPress={() => router.push(`/transactions/${row.transactionId}` as never)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowTitle}>{row.merchant}</Text>
                      <Text style={styles.rowMeta}>
                        {row.partial ? "Partial · " : ""}
                        {row.evidenceStatus.replaceAll("_", " ")}
                      </Text>
                    </View>
                    <Text style={styles.rowAmount}>{money(row.businessAmount ?? "0")}</Text>
                  </Pressable>
                ))
              ) : (
                <Text style={styles.empty}>No confirmed business expenses yet.</Text>
              )}
            </View>
          </>
        )}
      </ScrollView>
      <Animated.View
        style={[
          styles.headerOverlay,
          { top: insets.top, height: HEADER_HEIGHT },
          header.headerStyle,
        ]}
      >
        <View style={styles.head}>
          <View>
            <Text style={styles.title}>Overview</Text>
            <Text style={styles.subtitle}>{month}</Text>
          </View>
        </View>
      </Animated.View>
      <View style={[styles.statusBarBg, { height: insets.top }]} />
    </View>
  );
}

function Metric({
  label,
  value,
  warning,
  last,
}: {
  label: string;
  value: string;
  warning?: boolean;
  last?: boolean;
}) {
  return (
    <View style={[styles.metric, !last && styles.metricBorder]}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, warning && styles.warning]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.canvas },
  headerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 10,
    backgroundColor: colors.canvas,
  },
  statusBarBg: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 11,
    backgroundColor: colors.canvas,
  },
  head: { paddingHorizontal: space.lg, paddingTop: 12, height: HEADER_HEIGHT },
  title: { ...type$.titleLg, color: colors.ink },
  subtitle: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  content: { paddingHorizontal: space.lg, paddingBottom: 80, flexGrow: 1 },
  center: { flex: 1, minHeight: 320, alignItems: "center", justifyContent: "center" },
  hero: { paddingVertical: space.sm, marginBottom: space.lg },
  heroLabel: { ...type$.captionStrong, color: colors.muted, textTransform: "uppercase" },
  heroValue: {
    fontSize: 40,
    lineHeight: 44,
    fontWeight: "500",
    letterSpacing: -0.8,
    color: colors.ink,
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  note: { ...type$.bodySm, color: colors.muted, marginTop: 6 },
  eyebrow: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    marginBottom: 6,
  },
  metrics: { backgroundColor: colors.surfaceSoft, borderRadius: 14, paddingHorizontal: space.base },
  metric: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.base,
  },
  metricBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  metricLabel: { ...type$.bodySm, color: colors.body },
  metricValue: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  warning: { color: colors.down },
  sectionHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: space.xl,
    marginBottom: 6,
  },
  sectionTitle: { ...type$.titleSm, color: colors.ink },
  link: { ...type$.captionStrong, color: colors.primary },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairlineSoft,
  },
  rowTitle: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  rowMeta: { ...type$.bodySm, color: colors.muted, textTransform: "capitalize", marginTop: 2 },
  rowAmount: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  empty: { ...type$.bodyMd, color: colors.muted, paddingVertical: space.lg },
  error: { ...type$.bodyMd, color: colors.down },
});
