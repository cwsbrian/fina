import { ReactNode } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, withAlpha, currencySymbol, CategoryIcon } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "transaction_detail" }>;

function Chip({
  category,
}: {
  category: { name: string; color?: string | null; icon?: string | null };
}) {
  return (
    <View
      style={[
        styles.chip,
        {
          backgroundColor: category.color
            ? withAlpha(category.color, 0.13)
            : colors.surfaceSoft,
        },
      ]}
    >
      <CategoryIcon icon={category.icon} color={category.color} size={12} />
      <Text
        style={[styles.chipText, { color: category.color ?? colors.body }]}
        numberOfLines={1}
      >
        {category.name}
      </Text>
    </View>
  );
}

function DetailRow({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      {children ?? <Text style={styles.detailValue}>{value}</Text>}
    </View>
  );
}

function sourceLabel(s: Block["source"]): string | null {
  switch (s) {
    case "plaid": return "Plaid sync";
    case "manual": return "Added manually";
    case "csv": return "CSV import";
    default: return null;
  }
}

export function TransactionDetailBlock({ block }: { block: Block }) {
  const sym = currencySymbol(block.currency);
  const showAllocations = (block.allocations?.length ?? 0) > 1;
  const src = sourceLabel(block.source);
  return (
    <Pressable
      onPress={() => router.push(`/transactions/${block.id}` as never)}
      accessibilityRole="button"
      accessibilityLabel="Open transaction"
      style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
    >
      <BlockCard>
        <View style={styles.headRow}>
          <Text style={styles.merchant} numberOfLines={2}>
            {block.merchant}
          </Text>
          <Text style={styles.amount}>
            {sym}
            {block.amount}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={colors.muted} />
        </View>

        <View style={styles.rows}>
          <DetailRow label="Date" value={block.date_label} />
          {block.account ? <DetailRow label="Account" value={block.account} /> : null}
          {block.category ? (
            <DetailRow label="Category">
              <View style={styles.valueWrap}>
                <Chip category={block.category} />
              </View>
            </DetailRow>
          ) : null}
          <DetailRow label="Status" value={block.pending ? "Pending" : "Posted"} />
          {src ? <DetailRow label="Source" value={src} /> : null}
          {block.note ? (
            <DetailRow label="Note">
              <Text style={[styles.detailValue, styles.note]}>{block.note}</Text>
            </DetailRow>
          ) : null}
        </View>

        {showAllocations ? (
          <View style={styles.allocs}>
            <Text style={styles.allocsTitle}>Splits</Text>
            {block.allocations!.map((a, i) => (
              <View key={i} style={styles.allocRow}>
                <Chip category={a.category} />
                <Text style={styles.allocAmount}>
                  {sym}
                  {a.amount}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
      </BlockCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.sm,
  },
  merchant: {
    ...type$.titleSm,
    color: colors.ink,
    flex: 1,
    minWidth: 0,
  },
  amount: {
    ...type$.titleSm,
    color: colors.ink,
    fontVariant: ["tabular-nums"],
  },
  rows: {
    marginTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
    paddingTop: space.xs,
    gap: 2,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 4,
    gap: space.sm,
  },
  detailLabel: {
    ...type$.caption,
    color: colors.muted,
    width: 72,
  },
  detailValue: {
    ...type$.bodySm,
    color: colors.ink,
    flex: 1,
    minWidth: 0,
  },
  valueWrap: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
  },
  note: {
    fontStyle: "italic",
    color: colors.body,
  },
  allocs: {
    marginTop: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.hairlineSoft,
    paddingTop: space.xs,
    gap: 6,
  },
  allocsTitle: {
    ...type$.caption,
    color: colors.muted,
  },
  allocRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.sm,
  },
  allocAmount: {
    ...type$.bodySm,
    color: colors.body,
    fontVariant: ["tabular-nums"],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  chipText: {
    ...type$.caption,
    fontWeight: "600",
  },
});
