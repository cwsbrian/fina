import { Pressable, Text, View, StyleSheet } from "react-native";
import { router } from "expo-router";
import { colors, space, type as type$ } from "../design/tokens";
import { formatMoney } from "../format/money";

export function SpendCard({
  currency,
  totalSpent,
  budgetCap,
}: {
  currency: string;
  /** Decimal string from /budget-plans/current totalSpent. */
  totalSpent: string;
  /** Decimal string sum of the plan's category caps, or null if no plan. */
  budgetCap: string | null;
}) {
  const spent = formatMoney(totalSpent, currency);
  const cap = budgetCap !== null ? formatMoney(budgetCap, currency) : null;
  const spentNum = Number(totalSpent);
  const capNum = budgetCap !== null ? Number(budgetCap) : 0;
  const pct = capNum > 0 ? Math.min(999, (spentNum / capNum) * 100) : 0;
  const over = pct > 100;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
      onPress={() => router.push("/budget" as never)}
    >
      <Text style={styles.amount}>{spent.display}</Text>
      <Text style={styles.label}>spent this month</Text>
      {cap ? (
        <>
          <View style={styles.barTrack}>
            <View
              style={[
                styles.barFill,
                { width: `${Math.min(100, pct)}%`, backgroundColor: over ? colors.down : colors.primary },
              ]}
            />
          </View>
          <Text style={[styles.barMeta, over && { color: colors.down }]}>
            of {cap.display} · {pct.toFixed(0)}%
          </Text>
        </>
      ) : (
        <Text style={styles.cta}>Set a budget →</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.canvas,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 16,
    padding: space.base,
    marginTop: space.base,
  },
  amount: { ...type$.titleLg, color: colors.ink },
  label: { ...type$.bodySm, color: colors.muted, marginTop: 2 },
  barTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceSoft,
    marginTop: space.sm,
    overflow: "hidden",
  },
  barFill: { height: 6, borderRadius: 3 },
  barMeta: { ...type$.bodySm, color: colors.body, marginTop: 4 },
  cta: { ...type$.captionStrong, color: colors.primary, marginTop: space.sm },
});
