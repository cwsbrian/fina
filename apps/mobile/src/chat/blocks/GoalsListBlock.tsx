import { View, Text, StyleSheet, Pressable } from "react-native";
import { router } from "expo-router";
import type { PresentationBlock } from "@fina/shared";
import { colors, space, type as type$ } from "../../design/tokens";
import { BlockCard, BlockHeader, BlockFooter, BlockEmpty, currencySymbol, CategoryIcon } from "./_primitives";

type Block = Extract<PresentationBlock, { type: "goals_list" }>;
type Props = { block: Block };

export function GoalsListBlock({ block }: Props) {
  const sym = currencySymbol(block.currency);
  return (
    <Pressable
      onPress={() => router.push("/goals" as never)}
      accessibilityRole="button"
      accessibilityLabel="Open goals"
      style={({ pressed }) => (pressed ? { opacity: 0.7 } : null)}
    >
      <BlockCard>
        <BlockHeader title={block.title} chevron />
        {block.rows.length === 0 ? (
          <BlockEmpty text="No goals yet." />
        ) : (
          <View style={{ marginTop: space.xs }}>
            {block.rows.map((r, i) => {
              const pct = Math.max(0, Math.min(100, r.bar_pct));
              return (
                <View key={r.id} style={[styles.row, i < block.rows.length - 1 && styles.rowBorder]}>
                  <View style={styles.line}>
                    <View style={styles.titleWrap}>
                      <CategoryIcon icon={r.icon} color={r.color} size={14} />
                      <Text style={styles.name} numberOfLines={1}>{r.title}</Text>
                    </View>
                    <Text style={styles.due}>{r.due_label}</Text>
                  </View>
                  <View style={styles.line}>
                    <Text style={[styles.amount, r.over && { color: colors.up }]}>
                      {sym}{r.saved} / {sym}{r.target}
                    </Text>
                    <Text style={styles.pct}>{Math.round(r.bar_pct)}%</Text>
                  </View>
                  <View style={styles.track}>
                    <View style={[styles.fill, { width: `${pct}%`, backgroundColor: r.color ?? colors.primary }]} />
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
  titleWrap: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 },
  name: { ...type$.bodyMd, color: colors.ink, fontWeight: "500", flex: 1, minWidth: 0 },
  due: { ...type$.caption, color: colors.muted, fontVariant: ["tabular-nums"] },
  amount: { ...type$.bodySm, color: colors.body, fontVariant: ["tabular-nums"] },
  pct: { ...type$.caption, color: colors.muted },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.hairline, overflow: "hidden" },
  fill: { height: "100%" },
});
