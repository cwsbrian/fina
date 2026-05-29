import { View, Text, StyleSheet, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { formatMoney } from "../../format/money";
import {
  BlockCard,
  BlockHeader,
  BlockFooter,
  BlockEmpty,
  CategoryIcon,
} from "./_primitives";

type Block = Extract<PresentationBlock, { type: "transactions_list" }>;
type Row = Block["rows"][number];

type Props = { block: Block };

/** Renders a transactions list — used by listTransactions, findTransactions,
 *  and findUncategorizedTransactions. Each row taps through to the
 *  transaction detail screen so the user can drill in without losing the
 *  chat context. */
export function TransactionsListBlock({ block }: Props) {
  const currencySymbol = currencyToSymbol(block.currency);
  return (
    <BlockCard>
      {block.period_label ? (
        <BlockHeader title={block.title} subtitle={block.period_label} />
      ) : (
        <BlockHeader title={block.title} />
      )}

      {block.total_amount ? (
        <Text style={styles.totalLine}>
          Total{" "}
          <Text style={styles.totalAmount}>
            {currencySymbol ?? ""}
            {block.total_amount}
          </Text>{" "}
          <Text style={styles.totalCount}>· {block.total_count} txs</Text>
        </Text>
      ) : (
        <Text style={styles.totalCountAlone}>
          {block.total_count} {block.total_count === 1 ? "transaction" : "transactions"}
        </Text>
      )}

      {block.rows.length === 0 ? (
        <BlockEmpty text="No transactions match." />
      ) : (
        <View style={styles.rows}>
          {block.rows.map((r, i) => (
            <TxRow
              key={r.id}
              row={r}
              isLast={i === block.rows.length - 1}
            />
          ))}
        </View>
      )}

      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

function TxRow({ row, isLast }: { row: Row; isLast: boolean }) {
  const money = formatMoney(row.amount, "CAD");
  const amountColor = money.isIncome ? colors.up : colors.ink;
  const amountText = money.isIncome ? `+${money.display}` : money.display;

  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        !isLast && styles.rowBorder,
        pressed && { backgroundColor: colors.surfaceSoft },
      ]}
      onPress={() => router.push(`/transactions/${row.id}` as never)}
    >
      <View style={styles.rowLeft}>
        <Text style={styles.dateLabel}>{row.date_label}</Text>
        <Text style={styles.merchant} numberOfLines={1}>
          {row.merchant}
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
          {row.needs_review ? (
            <View style={styles.reviewChip}>
              <Text style={styles.reviewChipText}>review</Text>
            </View>
          ) : null}
          {row.account ? (
            <Text style={styles.accountText} numberOfLines={1}>
              {row.account}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={styles.rowRight}>
        <Text
          style={[styles.amount, { color: amountColor }]}
          numberOfLines={1}
        >
          {amountText}
        </Text>
        <Ionicons name="chevron-forward" size={16} color={colors.muted} />
      </View>
    </Pressable>
  );
}

function currencyToSymbol(code: string | undefined): string | null {
  if (!code) return null;
  switch (code.toUpperCase()) {
    case "CAD": return "$";
    case "USD": return "US$";
    case "EUR": return "€";
    case "GBP": return "£";
    case "JPY": return "¥";
    case "KRW": return "₩";
    default:    return null;
  }
}

/** Convert a hex color to a translucent version for chip backgrounds.
 *  Returns the input unchanged if it doesn't look like #rgb / #rrggbb. */
function withAlpha(hex: string, alpha: number): string {
  const m6 = /^#([0-9a-f]{6})$/i.exec(hex);
  const m3 = /^#([0-9a-f]{3})$/i.exec(hex);
  let r: number, g: number, b: number;
  if (m6) {
    r = parseInt(m6[1]!.slice(0, 2), 16);
    g = parseInt(m6[1]!.slice(2, 4), 16);
    b = parseInt(m6[1]!.slice(4, 6), 16);
  } else if (m3) {
    r = parseInt(m3[1]![0]! + m3[1]![0]!, 16);
    g = parseInt(m3[1]![1]! + m3[1]![1]!, 16);
    b = parseInt(m3[1]![2]! + m3[1]![2]!, 16);
  } else {
    return hex;
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const styles = StyleSheet.create({
  totalLine: {
    ...type$.bodySm,
    color: colors.muted,
    marginTop: 2,
  },
  totalAmount: {
    color: colors.ink,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  totalCount: {
    color: colors.muted,
  },
  totalCountAlone: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 2,
  },
  rows: {
    marginTop: space.xs,
  },
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
  rowLeft: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  dateLabel: {
    ...type$.caption,
    color: colors.muted,
  },
  merchant: {
    ...type$.bodyMd,
    color: colors.ink,
    fontWeight: "500",
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 2,
  },
  catChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 6,
  },
  catName: {
    ...type$.caption,
    fontWeight: "600",
  },
  reviewChip: {
    paddingVertical: 2,
    paddingHorizontal: 6,
    borderRadius: 6,
    backgroundColor: colors.accentYellow ?? "#fff4cc",
  },
  reviewChipText: {
    ...type$.caption,
    color: colors.body,
    fontWeight: "600",
  },
  accountText: {
    ...type$.caption,
    color: colors.muted,
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  amount: {
    ...type$.bodyMd,
    fontVariant: ["tabular-nums"],
    fontWeight: "500",
    minWidth: 80,
    textAlign: "right",
  },
});
