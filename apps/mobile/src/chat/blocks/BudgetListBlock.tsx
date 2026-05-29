import { View, Text, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty, currencySymbol, CategoryIcon } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "budget_list" }>;
type Props = { block: Block };

export function BudgetListBlock({ block }: Props) {
  const sym = currencySymbol(block.currency);
  return (
    <Pressable
      onPress={() => router.push("/budget/new" as never)}
      accessibilityRole="button"
      accessibilityLabel="Edit budget"
      style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
    >
    <BlockCard>
      <BlockHeader title={block.title} chevron {...(block.period_label ? { subtitle: block.period_label } : {})} />
      {block.headline ? (
        <View style={styles.headline}>
          <Text style={styles.heroAmount}>{sym}{block.headline.spent}</Text>
          <Text style={styles.heroCap}>of {sym}{block.headline.cap}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, block.headline.bar_pct))}%`, backgroundColor: colors.primary }]} />
          </View>
          <View style={styles.heroMetaRow}>
            <Text style={styles.heroPct}>{Math.round(block.headline.bar_pct)}%</Text>
            <Text style={styles.heroLeft}>{sym}{block.headline.left} left</Text>
          </View>
          {block.headline.scheduled ? (
            <Text style={styles.heroScheduled}>+ {sym}{block.headline.scheduled} scheduled</Text>
          ) : null}
        </View>
      ) : null}
      {block.rows.length === 0 ? (
        <BlockEmpty text="No budgets set yet." />
      ) : (
        <View style={{ marginTop: space.xs }}>
          {block.rows.map((r, i) => {
            const pct = Math.max(0, Math.min(100, r.bar_pct));
            return (
              <View key={r.id} style={[styles.row, i < block.rows.length - 1 && styles.rowBorder]}>
                <View style={styles.line}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                    <CategoryIcon icon={r.category.icon} color={r.category.color} size={14} />
                    <Text style={styles.name} numberOfLines={1}>{r.category.name}</Text>
                  </View>
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
    </Pressable>
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
  headline: { gap: 4, paddingVertical: space.xs },
  heroAmount: { fontSize: 28, lineHeight: 34, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  heroCap: { ...type$.bodySm, color: colors.muted },
  heroMetaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heroPct: { ...type$.caption, color: colors.muted },
  heroLeft: { ...type$.caption, color: colors.primary, fontWeight: "600" },
  heroScheduled: { ...type$.caption, color: colors.muted },
});
