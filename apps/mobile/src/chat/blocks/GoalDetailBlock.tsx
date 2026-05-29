import { View, Text, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, currencySymbol, CategoryIcon } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "goal_detail" }>;
type Props = { block: Block };

export function GoalDetailBlock({ block }: Props) {
  const sym = currencySymbol(block.currency);
  const pct = Math.max(0, Math.min(100, block.bar_pct));
  return (
    <Pressable
      onPress={() => router.push(`/goals/${block.id}` as never)}
      accessibilityRole="button"
      accessibilityLabel={`Open goal ${block.title}`}
      style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
    >
      <BlockCard>
        <BlockHeader title={block.title} chevron subtitle={block.due_label} />
        <View style={styles.headline}>
          <Text style={styles.heroAmount}>{sym}{block.saved}</Text>
          <Text style={styles.heroCap}>of {sym}{block.target}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
          </View>
          <View style={styles.metaRow}>
            <Text style={styles.pct}>{Math.round(block.bar_pct)}%</Text>
            {typeof block.days_left === "number" ? (
              <Text style={styles.left}>
                {block.days_left >= 0 ? `${block.days_left} days left` : `${-block.days_left} days overdue`}
              </Text>
            ) : null}
          </View>
        </View>

        {block.allocations && block.allocations.length > 0 ? (
          <View style={styles.allocs}>
            <Text style={styles.allocsLabel}>Savings plan</Text>
            {block.allocations.map((a, i) => (
              <View key={`${a.category.name}-${i}`} style={styles.allocRow}>
                <View style={styles.allocLeft}>
                  <CategoryIcon icon={a.category.icon} color={a.category.color} size={14} />
                  <Text style={styles.allocName} numberOfLines={1}>{a.category.name}</Text>
                </View>
                <Text style={styles.allocAmount}>{sym}{a.monthly}/mo</Text>
              </View>
            ))}
          </View>
        ) : null}

        {block.note ? <Text style={styles.note}>{block.note}</Text> : null}
        {block.strategy_note ? <BlockFooter text={block.strategy_note} /> : null}
      </BlockCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headline: { gap: 4, paddingVertical: space.xs },
  heroAmount: { fontSize: 28, lineHeight: 34, fontWeight: "600", color: colors.ink, fontVariant: ["tabular-nums"] },
  heroCap: { ...type$.bodySm, color: colors.muted },
  metaRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pct: { ...type$.caption, color: colors.muted },
  left: { ...type$.caption, color: colors.primary, fontWeight: "600" },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.hairline, overflow: "hidden" },
  fill: { height: "100%" },
  allocs: { marginTop: space.sm, gap: 6 },
  allocsLabel: { ...type$.caption, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6 },
  allocRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  allocLeft: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 },
  allocName: { ...type$.bodySm, color: colors.ink, flex: 1, minWidth: 0 },
  allocAmount: { ...type$.bodySm, color: colors.body, fontVariant: ["tabular-nums"] },
  note: { ...type$.caption, color: colors.muted, marginTop: space.sm, fontStyle: "italic" },
});
