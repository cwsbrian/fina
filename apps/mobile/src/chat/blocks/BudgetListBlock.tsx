import { View, Text, StyleSheet } from "react-native";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty, currencySymbol } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "budget_list" }>;
type Props = { block: Block };

export function BudgetListBlock({ block }: Props) {
  const sym = currencySymbol(block.currency);
  return (
    <BlockCard>
      <BlockHeader title={block.title} {...(block.period_label ? { subtitle: block.period_label } : {})} />
      {block.rows.length === 0 ? (
        <BlockEmpty text="No budgets set yet." />
      ) : (
        <View style={{ marginTop: space.xs }}>
          {block.rows.map((r, i) => {
            const pct = Math.max(0, Math.min(100, r.bar_pct));
            return (
              <View key={r.id} style={[styles.row, i < block.rows.length - 1 && styles.rowBorder]}>
                <View style={styles.line}>
                  <Text style={styles.name} numberOfLines={1}>
                    {r.category.icon ? `${r.category.icon} ` : ""}{r.category.name}
                  </Text>
                  <Text style={[styles.amount, r.over && { color: colors.down }]}>
                    {sym}{r.spent} / {sym}{r.amount}
                  </Text>
                </View>
                <View style={styles.track}>
                  <View style={[styles.fill, { width: `${pct}%`, backgroundColor: r.over ? colors.down : (r.category.color ?? colors.primary) }]} />
                </View>
              </View>
            );
          })}
        </View>
      )}
      {block.footer ? <BlockFooter text={block.footer} /> : null}
    </BlockCard>
  );
}

const styles = StyleSheet.create({
  row: { paddingVertical: 10, gap: 6 },
  rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.hairlineSoft },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500", flex: 1, minWidth: 0 },
  amount: { ...type$.bodySm, color: colors.body, fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.hairline, overflow: "hidden" },
  fill: { height: "100%" },
});
