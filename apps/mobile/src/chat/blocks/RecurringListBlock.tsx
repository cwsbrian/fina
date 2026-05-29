import { View, Text, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import {
  BlockCard,
  BlockHeader,
  BlockFooter,
  BlockEmpty,
  withAlpha,
  currencySymbol,
  CategoryIcon,
} from "./_primitives";

type Block = Extract<PresentationBlock, { type: "recurring_list" }>;
type Row = Block["rows"][number];

type Props = { block: Block };

/** Read-only recurring expenses card. Each row shows the recurring's
 *  name, amount + cadence inline, next occurrence date, and an optional
 *  category chip. Tap-to-detail is intentionally deferred — recurring
 *  detail screen isn't routed yet; we'll wire it when the page lands. */
export function RecurringListBlock({ block }: Props) {
  const sym = currencySymbol(block.currency);
  return (
    <BlockCard>
      {block.period_label ? (
        <BlockHeader title={block.title} subtitle={block.period_label} />
      ) : (
        <BlockHeader title={block.title} />
      )}

      {block.total_monthly_amount ? (
        <Text style={styles.totalLine}>
          <Text style={styles.totalAmount}>
            {sym}
            {block.total_monthly_amount}
          </Text>{" "}
          <Text style={styles.totalCount}>/ mo · {block.total_count} active</Text>
        </Text>
      ) : (
        <Text style={styles.totalCountAlone}>
          {block.total_count} active recurring
        </Text>
      )}

      {block.rows.length === 0 ? (
        <BlockEmpty text="No recurring expenses yet." />
      ) : (
        <View style={styles.rows}>
          {block.rows.map((r, i) => (
            <RecurringRow
              key={r.id}
              row={r}
              currencySymbol={sym}
              isLast={i === block.rows.length - 1}
            />
          ))}
        </View>
      )}

      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

function RecurringRow({
  row,
  currencySymbol,
  isLast,
}: {
  row: Row;
  currencySymbol: string;
  isLast: boolean;
}) {
  return (
    <View style={[styles.row, !isLast && styles.rowBorder]}>
      <View style={styles.rowLeft}>
        <Text style={styles.name} numberOfLines={1}>
          {row.name}
        </Text>
        <View style={styles.metaRow}>
          {row.category ? (
            <View
              style={[
                styles.catChip,
                {
                  backgroundColor: row.category.color
                    ? withAlpha(row.category.color, 0.12)
                    : colors.surfaceSoft,
                },
              ]}
            >
              <CategoryIcon icon={row.category.icon} color={row.category.color} size={12} />
              <Text
                style={[
                  styles.catName,
                  { color: row.category.color ?? colors.body },
                ]}
                numberOfLines={1}
              >
                {row.category.name}
              </Text>
            </View>
          ) : null}
          <Text style={styles.nextDate} numberOfLines={1}>
            Next {formatNextDate(row.next_occurrence_date)}
          </Text>
        </View>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.amount}>
          {currencySymbol}
          {row.amount}
        </Text>
        <Text style={styles.cadence}>/ {cadenceLabel(row.cadence)}</Text>
      </View>
    </View>
  );
}

/** Render YYYY-MM-DD as "Today" / "Tomorrow" / "Mon May 5" / "May 5, 2025"
 *  — same hierarchy as transactions_list dates but anchored on the
 *  future side. */
function formatNextDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(Date.UTC(y, mo - 1, d));
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const days = Math.round((date.getTime() - todayUtc.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days > 1 && days < 7) {
    return date.toLocaleDateString(undefined, {
      weekday: "short",
      timeZone: "UTC",
    });
  }
  if (y === today.getFullYear()) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function cadenceLabel(c: Row["cadence"]): string {
  switch (c) {
    case "monthly":     return "mo";
    case "semimonthly": return "½ mo";
    case "biweekly":    return "2 wk";
    case "weekly":      return "wk";
    case "yearly":      return "yr";
  }
}

const styles = StyleSheet.create({
  totalLine: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  totalAmount: {
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  totalCount: { color: colors.muted },
  totalCountAlone: { ...type$.caption, color: colors.muted, marginTop: 2 },
  rows: { marginTop: space.xs },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    gap: space.sm,
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: colors.hairlineSoft,
  },
  rowLeft: { flex: 1, minWidth: 0, gap: 4 },
  rowRight: { alignItems: "flex-end", gap: 0 },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500" },
  metaRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  catChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  catName: { ...type$.caption, fontWeight: "600" },
  nextDate: { ...type$.caption, color: colors.muted },
  amount: {
    ...type$.bodyMd,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
    fontWeight: "500",
  },
  cadence: { ...type$.caption, color: colors.muted, marginTop: 1 },
});
