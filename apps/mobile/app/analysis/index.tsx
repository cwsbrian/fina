import { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Svg, { Circle, G, Line, Rect, Text as SvgText } from "react-native-svg";
import type { CategoryDTO } from "@fina/shared";
import { apiFetch, bootstrapActiveWorkspace } from "../../src/api/client";
import { getActiveWorkspaceId } from "../../src/workspace/active";
import { colors, space, type as type$ } from "../../src/design/tokens";
import { HeaderIconButton } from "../../src/design/HeaderIconButton";
import { formatMoney } from "../../src/format/money";
import { categoryMeta } from "../../src/categories/meta";
import { MonthPickerSheet } from "../../src/datetime/MonthPickerSheet";

type CategorySpend = {
  categoryId: string;
  categoryName: string;
  icon: string | null;
  color: string | null;
  amount: number;
};

type MonthAnalysis = {
  year: number;
  month: number;
  label: string;
  income: number;
  spend: number;
  net: number;
  spendByCategory: CategorySpend[];
};

type CashflowPoint = {
  year: number;
  month: number;
  label: string;
  income: number;
  spend: number;
};

type AnalysisResp = {
  current: MonthAnalysis;
  previous: MonthAnalysis | null;
  monthlyHistory: CashflowPoint[];
};

function nowYM(): { year: number; month: number } {
  const d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

const UNCATEGORIZED_ID = "__uncategorized__";

/** Append a synthetic Uncategorized row when the categorized totals
 *  fall short of the month's total spend. Mirrored on both current
 *  and previous so the compare list can show the delta on the
 *  Uncategorized bucket too. */
function withUncategorized(month: MonthAnalysis | null): CategorySpend[] {
  if (!month) return [];
  const sum = month.spendByCategory.reduce((s, c) => s + c.amount, 0);
  const remaining = Math.max(0, month.spend - sum);
  if (remaining < 0.005) return month.spendByCategory;
  return [
    ...month.spendByCategory,
    {
      categoryId: UNCATEGORIZED_ID,
      categoryName: "Uncategorized",
      icon: null,
      color: null,
      amount: Math.round(remaining * 100) / 100,
    },
  ];
}

export default function AnalysisScreen() {
  const [{ year, month }, setYM] = useState(() => nowYM());
  const [data, setData] = useState<AnalysisResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const wsId =
        (await getActiveWorkspaceId()) ?? (await bootstrapActiveWorkspace());
      if (!wsId) throw new Error("no_workspace");
      const r = await apiFetch<AnalysisResp>(
        `/workspaces/${wsId}/analysis?year=${year}&month=${month}`,
      );
      setData(r);
      setErr(null);
    } catch (e) {
      setErr((e as { code?: string }).code ?? "load_error");
    }
  }, [year, month]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <Stack.Screen options={{ headerShown: false }} />
      <Header onPickMonth={() => setPickerOpen(true)} />
      <Text style={styles.monthLine}>
        {new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
          month: "long",
          year: "numeric",
        })}
      </Text>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
          />
        }
      >
        {err && !data ? (
          <View style={styles.fallback}>
            <Text style={styles.errTitle}>Couldn't load analysis</Text>
            <Text style={styles.errBody}>{err}</Text>
            <Pressable style={styles.cta} onPress={load}>
              <Text style={styles.ctaText}>Try again</Text>
            </Pressable>
          </View>
        ) : !data ? (
          <View style={styles.fallback}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : (
          <>
            <CashflowCard analysis={data.current} history={data.monthlyHistory} />
            <SectionLabel>Where it went</SectionLabel>
            <SpendBreakdown
              spend={data.current.spend}
              byCategory={withUncategorized(data.current)}
            />
            <SectionLabel>
              vs {data.previous?.label.split(" ")[0] ?? "last month"}
            </SectionLabel>
            <CompareList
              current={withUncategorized(data.current)}
              previous={withUncategorized(data.previous)}
            />
          </>
        )}
      </ScrollView>
      <MonthPickerSheet
        visible={pickerOpen}
        year={year}
        month={month}
        onClose={() => setPickerOpen(false)}
        onSelect={(y, m) => {
          setYM({ year: y, month: m });
          setPickerOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

function Header({ onPickMonth }: { onPickMonth: () => void }) {
  return (
    <View style={styles.nav}>
      <HeaderIconButton
        icon="chevron-back"
        accessibilityLabel="Back"
        onPress={() => router.back()}
        variant="plain"
      />
      <Text style={styles.navTitle}>Analysis</Text>
      <HeaderIconButton
        icon="calendar-outline"
        accessibilityLabel="Pick a month"
        onPress={onPickMonth}
        variant="plain"
      />
    </View>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function CashflowCard({
  analysis,
  history,
}: {
  analysis: MonthAnalysis;
  history: CashflowPoint[];
}) {
  const { width: screenW } = useWindowDimensions();
  const chartW = Math.max(280, screenW - space.lg * 2 - space.base * 2);
  return (
    <View style={styles.card}>
      <Text style={styles.cardEyebrow}>Net cashflow</Text>
      <Text
        style={[
          styles.cardValue,
          { color: analysis.net >= 0 ? colors.up : colors.down },
        ]}
      >
        {analysis.net >= 0 ? "+" : "−"}
        {formatMoney(Math.abs(analysis.net).toFixed(2)).display}
      </Text>
      <View style={styles.cardMeta}>
        <Text style={styles.cardMetaText}>
          <Text style={{ color: colors.up, fontWeight: "600" }}>
            +{formatMoney(analysis.income.toFixed(2)).display}
          </Text>{" "}
          income
        </Text>
        <View style={styles.cardMetaDot} />
        <Text style={styles.cardMetaText}>
          <Text style={{ color: colors.down, fontWeight: "600" }}>
            −{formatMoney(analysis.spend.toFixed(2)).display}
          </Text>{" "}
          spend
        </Text>
      </View>
      <CashflowChart points={history} width={chartW} />
    </View>
  );
}

function CashflowChart({ points, width }: { points: CashflowPoint[]; width: number }) {
  const H = 140;
  const pad = 14;
  const maxRaw = Math.max(
    1,
    ...points.flatMap((p) => [p.income, p.spend]),
  );
  const barW = 9;
  const gap = 4;
  const groupW = barW * 2 + gap;
  const cellW = (width - pad * 2) / Math.max(1, points.length);
  const baselineY = H - 26;
  const currentIdx = points.length - 1;

  return (
    <Svg width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
      <Line
        x1={pad}
        y1={baselineY}
        x2={width - pad}
        y2={baselineY}
        stroke={colors.hairline}
        strokeWidth={1}
      />
      {points.map((p, i) => {
        const cx = pad + cellW * i + cellW / 2 - groupW / 2;
        const inH = (p.income / maxRaw) * (H - 50);
        const outH = (p.spend / maxRaw) * (H - 50);
        const isCurrent = i === currentIdx;
        return (
          <G key={`${p.year}-${p.month}`}>
            <Rect
              x={cx}
              y={baselineY - inH}
              width={barW}
              height={inH}
              fill={isCurrent ? colors.up : "rgba(31, 138, 91, 0.4)"}
              rx={2}
            />
            <Rect
              x={cx + barW + gap}
              y={baselineY - outH}
              width={barW}
              height={outH}
              fill={isCurrent ? colors.down : "rgba(207, 32, 47, 0.4)"}
              rx={2}
            />
            <SvgText
              x={cx + groupW / 2}
              y={H - 8}
              fontSize={11}
              fontWeight={isCurrent ? "600" : "400"}
              fill={isCurrent ? colors.ink : colors.muted}
              textAnchor="middle"
            >
              {p.label}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
}

function SpendBreakdown({
  spend,
  byCategory,
}: {
  spend: number;
  byCategory: CategorySpend[];
}) {
  // Donut + legend. Empty state when no spend at all.
  if (spend <= 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.emptyBody}>No spending this month yet.</Text>
      </View>
    );
  }

  // byCategory now includes the synthetic Uncategorized row (when
  // applicable) injected upstream by withUncategorized. Just map each
  // to the metadata the donut + legend need.
  type Segment = { key: string; name: string; amount: number; color: string };
  const segments: Segment[] = byCategory.map((s) => {
    if (s.categoryId === UNCATEGORIZED_ID) {
      return {
        key: s.categoryId,
        name: s.categoryName,
        amount: s.amount,
        color: colors.mutedSoft,
      };
    }
    const meta = categoryMeta({
      id: s.categoryId,
      name: s.categoryName,
      icon: s.icon,
      color: s.color,
    } as unknown as CategoryDTO);
    return {
      key: s.categoryId,
      name: s.categoryName,
      amount: s.amount,
      color: meta.fg,
    };
  });
  // Sort by amount descending so the biggest slice — Uncategorized
  // very often — leads the legend instead of getting dropped off the
  // bottom when the list is truncated.
  segments.sort((a, b) => b.amount - a.amount);

  const size = 140;
  const stroke = 18;
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  let acc = 0;
  return (
    <View style={[styles.card, styles.donutCard]}>
      <Svg width={size} height={size}>
        <Circle cx={cx} cy={cy} r={r} stroke={colors.surfaceStrong} strokeWidth={stroke} fill="none" />
        {segments.map((s) => {
          const len = (s.amount / spend) * circumference;
          const dash = `${len} ${circumference - len}`;
          const offset = -acc;
          acc += len;
          return (
            <Circle
              key={s.key}
              cx={cx}
              cy={cy}
              r={r}
              stroke={s.color}
              strokeWidth={stroke}
              fill="none"
              strokeDasharray={dash}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
        })}
        <SvgText
          x={cx}
          y={cy - 4}
          fontSize={10}
          fill={colors.muted}
          textAnchor="middle"
        >
          SPENT
        </SvgText>
        <SvgText
          x={cx}
          y={cy + 14}
          fontSize={18}
          fontWeight="600"
          fill={colors.ink}
          textAnchor="middle"
        >
          {formatMoney(spend.toFixed(0)).display}
        </SvgText>
      </Svg>
      <View style={styles.legend}>
        {segments.map((s) => (
          <View key={s.key} style={styles.legendRow}>
            <View style={[styles.legendDot, { backgroundColor: s.color }]} />
            <Text style={styles.legendName} numberOfLines={1}>
              {s.name}
            </Text>
            <Text style={styles.legendAmount}>
              {formatMoney(s.amount.toFixed(0)).display}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function CompareList({
  current,
  previous,
}: {
  current: CategorySpend[];
  previous: CategorySpend[];
}) {
  const prevByCat = useMemo(
    () => new Map(previous.map((p) => [p.categoryId, p.amount])),
    [previous],
  );
  if (current.length === 0) {
    return (
      <View style={styles.card}>
        <Text style={styles.emptyBody}>
          Nothing to compare yet — log a few transactions to see the trend.
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.card}>
      {current.slice(0, 8).map((c, i) => {
        const prev = prevByCat.get(c.categoryId) ?? 0;
        const delta = c.amount - prev;
        const pct = prev > 0 ? Math.round((delta / prev) * 100) : null;
        const flat = prev > 0 && delta === 0;
        return (
          <CompareRow
            key={c.categoryId}
            category={c}
            delta={delta}
            pct={pct}
            flat={flat}
            isLast={i === Math.min(current.length, 8) - 1}
          />
        );
      })}
    </View>
  );
}

function CompareRow({
  category,
  delta,
  pct,
  flat,
  isLast,
}: {
  category: CategorySpend;
  delta: number;
  pct: number | null;
  flat: boolean;
  isLast: boolean;
}) {
  const isUncategorized = category.categoryId === UNCATEGORIZED_ID;
  const meta = isUncategorized
    ? {
        icon: "ellipsis-horizontal-outline" as const,
        fg: colors.muted,
        bg: colors.surfaceSoft,
      }
    : categoryMeta({
        id: category.categoryId,
        name: category.categoryName,
        icon: category.icon,
        color: category.color,
      } as unknown as CategoryDTO);
  const up = delta > 0;
  const down = delta < 0;
  let deltaText: string;
  let deltaColor: string;
  if (flat) {
    deltaText = "no change";
    deltaColor = colors.muted;
  } else if (pct === null) {
    deltaText = "new";
    deltaColor = colors.muted;
  } else {
    const sign = pct > 0 ? "+" : "";
    deltaText = `${sign}${pct}%`;
    deltaColor = up ? colors.down : down ? colors.up : colors.muted;
  }
  return (
    <View
      style={[
        styles.compareRow,
        !isLast && {
          borderBottomWidth: 1,
          borderBottomColor: colors.hairlineSoft,
        },
      ]}
    >
      <View style={[styles.compareGlyph, { backgroundColor: meta.bg }]}>
        <Ionicons name={meta.icon} size={14} color={meta.fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.compareName} numberOfLines={1}>
          {category.categoryName}
        </Text>
        <Text style={styles.compareAmount}>
          {formatMoney(category.amount.toFixed(2)).display}
        </Text>
      </View>
      <View style={styles.compareDelta}>
        {!flat && pct !== null && (
          <Ionicons
            name={up ? "trending-up" : "trending-down"}
            size={12}
            color={deltaColor}
          />
        )}
        <Text style={[styles.compareDeltaText, { color: deltaColor }]}>
          {deltaText}
        </Text>
      </View>
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
  navTitle: { ...type$.titleSm, color: colors.ink, fontWeight: "600" },
  scroll: { padding: space.lg, paddingBottom: space.xl },
  fallback: { alignItems: "center", paddingVertical: space.xxl },
  errTitle: { ...type$.titleMd, color: colors.down, marginBottom: 4 },
  errBody: { ...type$.bodyMd, color: colors.body, marginBottom: space.base, textAlign: "center" },
  emptyBody: {
    ...type$.bodyMd,
    color: colors.muted,
    textAlign: "center",
    paddingVertical: space.base,
  },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: 999,
  },
  ctaText: { ...type$.bodyMd, color: colors.onPrimary, fontWeight: "600" },

  // The month label that lives between the header and the body —
  // calendar icon in the header opens a sheet picker; this just
  // shows which month is currently displayed.
  monthLine: {
    ...type$.bodyMd,
    color: colors.muted,
    textAlign: "center",
    paddingTop: space.base,
    paddingBottom: space.sm,
  },

  sectionLabel: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: space.lg,
    marginBottom: space.sm,
  },

  card: {
    backgroundColor: colors.canvas,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.hairlineSoft,
    padding: space.base,
  },
  cardEyebrow: {
    ...type$.captionStrong,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  cardValue: {
    fontSize: 32,
    fontWeight: "600",
    color: colors.ink,
    letterSpacing: -0.8,
  },
  cardMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
    marginBottom: space.sm,
    flexWrap: "wrap",
  },
  cardMetaText: { ...type$.bodySm, color: colors.body },
  cardMetaDot: {
    width: 3,
    height: 3,
    borderRadius: 999,
    backgroundColor: colors.mutedSoft,
  },

  donutCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.base,
  },
  legend: { flex: 1, gap: 4 },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  legendDot: { width: 8, height: 8, borderRadius: 999 },
  legendName: { ...type$.bodySm, color: colors.ink, flex: 1 },
  legendAmount: { ...type$.bodySm, color: colors.muted, fontWeight: "600" },

  compareRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingVertical: 10,
  },
  compareGlyph: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  compareName: { ...type$.bodyMd, color: colors.ink, fontWeight: "600" },
  compareAmount: { ...type$.bodySm, color: colors.muted, marginTop: 1 },
  compareDelta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  compareDeltaText: { ...type$.bodySm, fontWeight: "600" },
});
