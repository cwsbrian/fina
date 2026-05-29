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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
        <CategoryIcon icon={category.icon} color={category.color} size={12} />
        <Text
          style={[styles.chipText, { color: category.color ?? colors.body }]}
          numberOfLines={1}
        >
          {category.name}
        </Text>
      </View>
    </View>
  );
}

export function TransactionDetailBlock({ block }: { block: Block }) {
  const sym = currencySymbol(block.currency);
  const showAllocations = (block.allocations?.length ?? 0) > 1;
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
      <Text style={styles.meta}>
        {block.date_label}
        {block.account ? ` · ${block.account}` : ""}
        {block.pending ? " · pending" : ""}
      </Text>
      {block.category ? (
        <View style={styles.chips}>
          <Chip category={block.category} />
        </View>
      ) : null}
      {block.note ? <Text style={styles.note}>{block.note}</Text> : null}
      {showAllocations ? (
        <View style={styles.allocs}>
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
    alignItems: "flex-start",
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
  meta: {
    ...type$.caption,
    color: colors.muted,
    marginTop: 2,
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: space.xs,
  },
  note: {
    ...type$.bodySm,
    color: colors.body,
    marginTop: space.xs,
    fontStyle: "italic",
  },
  allocs: {
    marginTop: space.sm,
    gap: 6,
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
